import type { Worker } from "bullmq";
import { logger } from "../observability/logger.js";
import { turnWorker as makeTurnWorker, turnQueue, type TurnJobData } from "../queue/turns.js";
import { withConversationLock } from "../queue/locks.js";
import { isTakenOver } from "../admin/takeover.js";
import { tickStateMachine } from "../state/machine.js";
import { sleepDecision } from "../state/sleep.js";
import { loadLatestArchetype } from "../db/repos/archetypes.js";
import { loadAccountById } from "../db/repos/accounts.js";
import { classifyIntent } from "../classify/intent.js";
import { loadCurrentFacts } from "../db/repos/subscriber_facts.js";
import { renderArchetypeDirective } from "../prompt/layers/archetype.js";
import { pickRelevantFacts } from "../prompt/layers/facts.js";
import { decideClassifierTrigger } from "../archetype/triggers.js";
import { classifyArchetype } from "../archetype/classifier.js";
import { extractAndPersistFacts } from "../facts/extractor.js";
import { decidePitch, turnsSinceLastPitch, logPitchDecision } from "../ppv/orchestrator.js";
import { pickPacingVariant } from "../humanness/pacing.js";
import { metrics } from "../observability/metrics.js";
import { loadUnrepliedInbound } from "../db/repos/messages.js";
import { countConversationTurns } from "../db/repos/conversations.js";
import { generateReply } from "./replyPipeline.js";
import { env } from "../config/index.js";

/**
 * Consumes debounced per-conversation turn jobs. A single fire of this worker
 * represents one logical "turn" — the fan has stopped typing (for at least
 * BURST_WINDOW_MS), we load everything they said since our last reply, and we
 * respond once to the whole thread.
 *
 * If new inbound arrives WHILE this worker is generating, we re-enqueue a
 * follow-up turn job right after we finish so the newcomer is not dropped.
 */
export function startTurnWorker(): Worker<TurnJobData> {
  const w = makeTurnWorker(async (job) => {
    const { accountId, conversationId, subscriberId, subscriberExternalId } = job.data;
    const ctx = { conversationId };

    if (await isTakenOver(conversationId)) {
      logger.info(ctx, "conversation under operator takeover; skipping auto-reply");
      return;
    }

    // Snapshot of the latest inbound message id before we start generating. If
    // a newer one appears after we finish, we re-schedule another turn.
    const unreadBefore = await loadUnrepliedInbound(conversationId);
    if (unreadBefore.length === 0) {
      logger.debug(ctx, "turn job fired but no unreplied inbound — skipping");
      return;
    }
    const watermarkBefore = unreadBefore[unreadBefore.length - 1]!.id;

    // Build a single "incoming text" that represents the whole burst. The
    // context window already contains every message individually; this is
    // used for intent detection, fact retrieval, and pitch-gate heuristics.
    const incomingText = unreadBefore
      .map((m) => (m.text ?? "").trim())
      .filter((t) => t.length > 0)
      .join("\n");

    if (!incomingText) {
      logger.debug(ctx, "no text content in unread inbound — skipping");
      return;
    }

    const turnStart = Date.now();
    await withConversationLock(conversationId, async () => {
      const tick = await tickStateMachine({ conversationId, subscriberId });
      if (!tick) {
        logger.warn(ctx, "state tick returned null — skipping reply");
        return;
      }

      const sleep = sleepDecision();
      if (sleep.asleep) {
        logger.info(
          { ...ctx, replyAt: sleep.replyAt?.toISOString() },
          "persona asleep — deferring reply",
        );
      }

      const [archetype, facts, turnIndex, sinceLastPitch, account, intent] = await Promise.all([
        loadLatestArchetype(subscriberId),
        loadCurrentFacts(subscriberId, 30),
        countConversationTurns(conversationId),
        turnsSinceLastPitch(conversationId),
        loadAccountById(accountId),
        classifyIntent(incomingText),
      ]);

      logger.debug(
        {
          ...ctx,
          intent: {
            buy: intent.buying_signal,
            obj: intent.objection,
            imp: intent.impossible_request,
            dis: intent.disengagement,
            emo: intent.emotional_disclosure,
            ai: intent.ai_question,
            c: intent.confidence,
          },
        },
        "intent classified",
      );

      const archetypeDirective = archetype ? renderArchetypeDirective(archetype) : undefined;
      const factStrings = pickRelevantFacts({ facts, inboundText: incomingText, k: 5 });

      // Hybrid buying-signal: regex fast-path OR LLM classifier. Objection,
      // disengagement, and emotional disclosure suppress pitching even if the
      // regex or classifier flagged a buying signal — fan mood wins.
      const regexAsk = detectExplicitAsk(incomingText);
      const pitchSuppressed =
        intent.objection || intent.disengagement || intent.emotional_disclosure;
      const explicitRequest = (regexAsk || intent.buying_signal) && !pitchSuppressed;

      const pitchDecision = await decidePitch({
        accountId,
        creatorUuid: account?.creatorUuid ?? null,
        subscriberId,
        subscriberExternalId,
        conversationId,
        phase: tick.phase,
        archetype,
        turnsSinceLastPitch: sinceLastPitch,
        explicitRequest,
      });
      logPitchDecision(conversationId, pitchDecision);

      const reply = await generateReply({
        accountId,
        conversationId,
        subscriberId,
        subscriberExternalId,
        incomingText,
        turnIndex,
        phase: tick.phase,
        extraLeadMs: sleep.asleep ? sleep.delayMs : 0,
        archetype,
        intent,
        ...(archetypeDirective !== undefined ? { archetypeDirective } : {}),
        ...(factStrings.length > 0 ? { facts: factStrings } : {}),
        ...(pitchDecision.shouldPitch && pitchDecision.asset && pitchDecision.priceCents != null
          ? { pitch: { asset: pitchDecision.asset, priceCents: pitchDecision.priceCents } }
          : {}),
      });

      if (reply?.ppvAttemptId) {
        metrics.ppvPitched.inc(1, { pacing: pickPacingVariant(conversationId).id });
      }
      if (tick.transitioned) metrics.stateTransitions.inc();

      // Fact extraction + archetype refresh. Never block the reply.
      const latestInboundMessage = unreadBefore[unreadBefore.length - 1]!;
      void runAsyncAnalyzers({
        subscriberId,
        conversationId,
        inboundText: incomingText,
        sourceMessageId: latestInboundMessage.id,
        suggestedFacts: reply?.suggestedFacts ?? [],
      }).catch((err) => {
        logger.warn(
          { ...ctx, err: err instanceof Error ? err.message : err },
          "async analyzers failed",
        );
      });
    });

    metrics.turnLatency.observe(Date.now() - turnStart);

    // If new inbound landed during generation, the watermark will have moved.
    // Schedule another turn (no delay needed — it's already been waiting).
    const unreadAfter = await loadUnrepliedInbound(conversationId);
    const latestAfter = unreadAfter[unreadAfter.length - 1]?.id;
    if (latestAfter && latestAfter !== watermarkBefore) {
      logger.info(ctx, "new inbound arrived during turn generation — scheduling follow-up");
      await turnQueue().add(
        "turn",
        { accountId, conversationId, subscriberId, subscriberExternalId },
        { jobId: `turn-${conversationId}`, delay: env.BURST_WINDOW_MS },
      );
    }
  });

  w.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err?.message }, "turn job failed");
  });
  w.on("completed", (job) => {
    logger.debug({ jobId: job.id }, "turn job ok");
  });

  logger.info("turn worker started");
  return w;
}

/**
 * Cheap heuristic — the fan is overtly asking for content. Overrides phase
 * gate + cooldowns so the bot can pitch in WARMUP/RAPPORT when the fan is
 * clearly buying.
 *
 * Covers:
 *   - "send it / send that / send me it / send me something"
 *   - "show me / let me see / can i see"
 *   - "gimme / give it to me / drop it"
 *   - "i wanna see / i want it / i want that / i want to see"
 *   - "what u got / what do you have"
 *   - "unlock / buy / purchase"
 *   - the old "send me a pic / vid / content" form
 */
function detectExplicitAsk(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();

  // Strong single-phrase signals.
  const phrases = [
    /\bsend (it|that|them|those|me|over|that over)\b/,
    /\bshow (me|it|that|them|those|us)\b/,
    /\blet me see\b/,
    /\bcan i (see|have|get)\b/,
    /\bi (wanna|want to|wna|wanna) see\b/,
    /\bi want (it|that|them|those|to see|your|some)\b/,
    /\b(gimme|give me|give it)\b/,
    /\bdrop (it|that|some|one|a)\b/,
    /\bwhat (u|you|do you) (got|have)\b/,
    /\bunlock\b/,
    /\b(buy|purchase|pay for)\b/,
    // direct imperatives in a standalone clause
    /(^|[.?! ])(send|show|drop)\b/,
  ];
  for (const re of phrases) {
    if (re.test(t)) return true;
  }

  // Verb + noun combination (legacy form).
  if (/\b(send|show|see|got|any|something|gimme)\b.*\b(pic|pics|vid|vids|video|videos|content|more|stuff|clip|clips|set|teaser)\b/.test(t)) {
    return true;
  }
  return false;
}

async function runAsyncAnalyzers(args: {
  subscriberId: string;
  conversationId: string;
  inboundText: string;
  sourceMessageId: string;
  suggestedFacts: Array<{ key: string; value: string; confidence: number }>;
}): Promise<void> {
  const [, trigger] = await Promise.all([
    extractAndPersistFacts({
      subscriberId: args.subscriberId,
      conversationId: args.conversationId,
      sourceMessageId: args.sourceMessageId,
      inboundText: args.inboundText,
      suggestedFacts: args.suggestedFacts,
    }),
    decideClassifierTrigger({ subscriberId: args.subscriberId }),
  ]);
  if (trigger) {
    await classifyArchetype({
      subscriberId: args.subscriberId,
      conversationId: args.conversationId,
      depth: trigger,
    });
  }
}
