import { logger } from "../observability/logger.js";
import { routeLlmCall } from "../llm/router.js";
import { assemblePrompt } from "../prompt/assemble.js";
import { parseGeneratorOutput } from "../prompt/parse.js";
import { humanizeTurn, type HumanizedTurn } from "../humanness/pipeline.js";
import { seededRng } from "../humanness/rng.js";
import { filterNonRepeating, recordRecentBubbles, loadRecentEmojis, recordRecentEmojis } from "../humanness/dedup.js";
import { emojisOf } from "../humanness/cleanup.js";
import { deriveAntiMirrorDirective, scrubMirrorOpeners } from "../humanness/antimirror.js";
import type { IntentFlags } from "../classify/intent.js";
import { pickPacingVariant } from "../humanness/pacing.js";
import { loadRecentMessages } from "../db/repos/messages.js";
import { insertOutboundDraft } from "../db/repos/messages.js";
import { outboundQueue, type OutboundJobData } from "../queue/outbound.js";
import { PHASE_DIRECTIVES, COLD_REPLIES } from "../state/directives.js";
import { computeTimings } from "../humanness/timing.js";
import { insertPpvAttempt } from "../db/repos/ppv_attempts.js";
import { incrementAttemptCounter } from "../db/repos/ppv_catalog.js";
import { bumpAttempt } from "../db/repos/asset_performance.js";
import { archetypeSlice } from "../ppv/ranker.js";
import type { LatestArchetypeRow } from "../db/repos/archetypes.js";
import type { PpvCatalogRow } from "../db/repos/ppv_catalog.js";
import type { ContextMessage } from "../prompt/layers/context.js";
import type { GeneratorTaskKind } from "../prompt/layers/task.js";
import type { Phase } from "../state/types.js";
import type { GeneratorOutput } from "../prompt/output.js";

export interface GenerateReplyInput {
  accountId: string;
  conversationId: string;
  subscriberId: string;
  subscriberExternalId: string;
  incomingText: string;
  turnIndex: number;
  phase: Phase;
  /** Optional per-turn overrides. */
  taskKind?: GeneratorTaskKind;
  archetypeDirective?: string;
  facts?: string[];
  /** Additional lead-in delay applied to the first bubble (e.g. sleep wake-up). */
  extraLeadMs?: number;
  /** Pitch this asset at this price on the final bubble. */
  pitch?: {
    asset: PpvCatalogRow;
    priceCents: number;
  };
  /** Archetype snapshot — only used for asset_performance rollups when pitching. */
  archetype?: LatestArchetypeRow | null;
  /** When set, treat this as an unprompted outbound (broadcast). Uses the text as the task objective. */
  broadcastObjective?: string;
  /** Classified intent of the fan's inbound this turn. Drives TASK-layer pattern triggers. */
  intent?: IntentFlags;
}

export interface GenerateReplyResult {
  bubbles: string[];
  draftMessageIds: string[];
  llmCallId?: string;
  phaseTransitionHint: Phase | null;
  detectedIntents: string[];
  suggestedFacts: GeneratorOutput["suggested_facts"];
  ppvAttemptId?: string;
}

/**
 * End-to-end turn generator. Branches on phase:
 *   - COLD  → canned reply, no LLM call
 *   - other → full LLM pipeline with state directive injected
 *
 * Returns null if generation should be skipped (refusal, parse failure, etc.).
 */
export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult | null> {
  const directive = PHASE_DIRECTIVES[input.phase];
  // Broadcasts always go through the LLM — a canned cold reply would be
  // indistinguishable from spam when it arrives unprompted.
  if (directive.canned && !input.broadcastObjective) {
    return generateCannedReply(input);
  }
  return generateLlmReply(input, directive.contextWindow ?? 12);
}

async function generateLlmReply(
  input: GenerateReplyInput,
  contextWindow: number,
): Promise<GenerateReplyResult | null> {
  const history = await loadRecentMessages(input.conversationId, contextWindow);
  const historyForPrompt: ContextMessage[] = history
    .filter(
      (m) =>
        (m.direction === "inbound" || m.direction === "outbound") &&
        typeof m.text === "string" &&
        m.text.length > 0,
    )
    .map((m) => ({
      direction: m.direction === "inbound" ? "inbound" : "outbound",
      text: m.text ?? "",
      createdAt: m.createdAt,
    }));

  const directive = PHASE_DIRECTIVES[input.phase];
  const isPitch = input.pitch != null;
  const isBroadcast = input.broadcastObjective != null;
  // Broadcasts have no inbound text to echo; everything else can mirror.
  const antiMirror = isBroadcast ? null : deriveAntiMirrorDirective(input.incomingText);

  // When we're pitching, the phase's "do not pitch / do not mention price /
  // do not promise to send" rules would directly contradict the task. The
  // orchestrator already decided a pitch is appropriate (buying signal
  // detected or phase is monetising) — strip those specific forbiddens from
  // the state layer while keeping tone-related ones. Also override the state
  // directive with a pitch-friendly version that preserves the phase's
  // conversational register.
  const PITCH_CONFLICT_KEYWORDS = ["pitch", "ppv", "price", "promise", "paid", "offer", "send anything"];
  const phaseForbiddensForPitch = isPitch
    ? directive.forbiddens.filter(
        (f) => !PITCH_CONFLICT_KEYWORDS.some((kw) => f.toLowerCase().includes(kw)),
      )
    : directive.forbiddens;

  const task: {
    kind: GeneratorTaskKind;
    objective: string;
    forbiddens: string[];
    details?: Record<string, string | number | null | undefined>;
    turnGuidance?: string;
  } = isPitch
    ? {
        kind: "pitch",
        objective:
          (isBroadcast
            ? "This is an outbound message — the fan has not written to you this turn. Open naturally and personal, then pitch the asset below as the last bubble. Keep it warm, not salesy."
            : "The fan is signalling they want content — close the loop now. Deliver the asset below as the last bubble. Do NOT stall with another 'what gets you going' question — the question phase is over for this turn. Keep prelude short (0–1 bubble of warm-up), then attach the asset with a caption that teases what's in it. Natural, not salesy.") +
          " The asset is sent as the last bubble; earlier bubbles are regular text.",
        forbiddens: [
          "do not send more than 3 bubbles",
          "do not mention any price except the one given",
          "do not ask another preference-gathering question this turn — deliver the content",
          ...phaseForbiddensForPitch,
        ],
        details: {
          asset_title: input.pitch!.asset.title,
          asset_description: input.pitch!.asset.description ?? "",
          asset_tags: input.pitch!.asset.tags.join(", "),
          price_usd: (input.pitch!.priceCents / 100).toFixed(2),
        },
      }
    : isBroadcast
      ? {
          kind: "broadcast",
          objective: `This is an outbound message — the fan has not written to you this turn. ${input.broadcastObjective!}`,
          forbiddens: ["do not send more than 3 bubbles", ...directive.forbiddens],
        }
      : {
          kind: input.taskKind ?? ("reply" as GeneratorTaskKind),
          objective:
            "Reply to the fan's latest message. Stay in character. Advance the state goal by one small step. The state directive governs what you can and cannot do this turn.",
          forbiddens: ["do not send more than 3 bubbles", ...directive.forbiddens],
        };

  // Compose per-turn guidance. Anti-mirror is always present when there's
  // inbound; intent-driven nudges (AI question, impossible request,
  // emotional disclosure) attach on top.
  const guidanceParts: string[] = [];
  if (antiMirror) guidanceParts.push(antiMirror);
  if (input.intent?.ai_question) {
    guidanceParts.push(
      [
        `AI-status question detected (this turn):`,
        `The fan just asked whether you are AI / real / a bot. Apply the AI disclosure rule from the CONTRACT layer: deflect warmly and playfully, neither confirming nor denying, then change the subject. Do not say "yes" to AI and do not claim you are human.`,
      ].join("\n"),
    );
  }
  if (input.intent?.impossible_request) {
    guidanceParts.push(
      [
        `Impossible-request redirect (this turn):`,
        `The fan asked you to do something a chat persona cannot actually do (prove you're real, video call now, take a new pic right now, meet up, etc.). Apply the Impossible-request redirect rule from the CONTRACT layer: do NOT attempt it, do NOT explain your limits. Redirect the energy into an in-character version of the connection they want.`,
      ].join("\n"),
    );
  }
  if (input.intent?.emotional_disclosure) {
    guidanceParts.push(
      [
        `Emotional disclosure (this turn):`,
        `The fan just shared something heavy. Soften your tone, acknowledge briefly and warmly in 1 short bubble, no flirtation, no pitching. Do NOT say "i'm here for you" verbatim — find a natural in-character version.`,
      ].join("\n"),
    );
  }
  if (input.intent?.objection) {
    guidanceParts.push(
      [
        `Objection (this turn):`,
        `The fan is pushing back (price, not my thing, maybe later). Do not pitch. Acknowledge lightly without defensiveness and pivot to a safer topic or tease.`,
      ].join("\n"),
    );
  }
  if (input.intent?.disengagement) {
    guidanceParts.push(
      [
        `Disengagement (this turn):`,
        `The fan is ending the exchange for now. Reply with one short warm line that leaves the door open. No pitching, no long messages, no multiple bubbles.`,
      ].join("\n"),
    );
  }
  if (guidanceParts.length > 0) task.turnGuidance = guidanceParts.join("\n\n");

  // When pitching in a pre-pitch phase (triggered by an explicit buying
  // signal) the phase's own "no pitch" directive would countermand the task.
  // Replace it with a pitch-friendly version that still reads the phase's
  // tone cue — we don't want to turn a WARMUP pitch into a WHALE pitch in
  // voice, just permit the offer itself.
  const stateDirective = isPitch
    ? `Phase: ${input.phase} (buying-signal override). The fan asked for content this turn, so a pitch is authorised. Keep the tone appropriate to ${input.phase} (${input.phase === "WARMUP" ? "still getting to know each other — warm, playful, not deep" : input.phase === "RAPPORT" ? "familiar but not yet whale-intimate" : "standard flirty register"}) but deliver the asset. Do not stall.`
    : directive.directive;

  const assembled = assemblePrompt({
    accountId: input.accountId,
    history: historyForPrompt,
    task,
    stateDirective,
    ...(input.archetypeDirective !== undefined ? { archetypeDirective: input.archetypeDirective } : {}),
    ...(input.facts !== undefined ? { facts: input.facts } : {}),
    contextWindow,
  });

  const ctx = { conversationId: input.conversationId, turn: input.turnIndex, phase: input.phase };

  let llmResult;
  try {
    llmResult = await routeLlmCall({
      task: "CHAT_GENERATE",
      messages: assembled.messages,
      responseFormat: "json_object",
      meta: {
        conversationId: input.conversationId,
        subscriberId: input.subscriberId,
        accountId: input.accountId,
        phase: input.phase,
        promptVersions: assembled.versions,
      },
    });
  } catch (err) {
    logger.error({ ...ctx, err: err instanceof Error ? err.message : err }, "llm route failed");
    return null;
  }

  let parsed = parseGeneratorOutput(llmResult.content);
  if (!parsed.ok) {
    logger.warn({ ...ctx, err: parsed.error }, "generator output parse failed; retrying");
    const retryMessages = [
      ...assembled.messages,
      { role: "assistant" as const, content: llmResult.content },
      {
        role: "system" as const,
        content:
          "Your previous reply did not parse as valid JSON. Return ONLY a JSON object matching the output spec, no prose and no code fences. Retry now.",
      },
    ];
    try {
      llmResult = await routeLlmCall({
        task: "CHAT_GENERATE",
        messages: retryMessages,
        responseFormat: "json_object",
        meta: {
          conversationId: input.conversationId,
          subscriberId: input.subscriberId,
          accountId: input.accountId,
          phase: input.phase,
          retry: true,
        },
      });
      parsed = parseGeneratorOutput(llmResult.content);
    } catch (err) {
      logger.error({ ...ctx, err: err instanceof Error ? err.message : err }, "llm retry failed");
      return null;
    }
  }

  if (!parsed.ok || !parsed.data) {
    logger.error({ ...ctx, err: parsed.error }, "generator output still unparseable after retry; giving up");
    return null;
  }

  const output = parsed.data;
  if (output.refusal_reason) {
    logger.warn({ ...ctx, reason: output.refusal_reason }, "generator refused; no reply sent");
    return null;
  }

  const recentEmojis = await loadRecentEmojis(input.conversationId);
  // If the last 3 replies each included an emoji, this turn gets none.
  const allowEmoji = recentEmojis.slice(0, 3).length < 3;

  const humanized = humanizeTurn({
    bubbles: output.bubbles,
    seedKey: `${input.conversationId}:${input.turnIndex}`,
    styleSeed: input.conversationId,
    modelDelayHintMs: output.delay_ms_before_first ?? null,
    modelGapHintMs: output.gap_ms_between_bubbles ?? null,
    recentEmojis,
    allowEmoji,
  });
  if (humanized.bubbles.length === 0) {
    logger.warn(ctx, "humanizer produced zero bubbles; skipping");
    return null;
  }

  // Deterministic fallback for when the model ignores the anti-mirror rule.
  // Strips an echo-opener from the first bubble when it parrots the fan.
  const scrubbed = scrubMirrorOpeners(humanized.bubbles, input.incomingText);
  if (scrubbed !== humanized.bubbles) {
    logger.debug(ctx, "stripped mirror opener from first bubble");
  }
  humanized.bubbles = scrubbed;

  // Drop bubbles whose n-gram shingles overlap with recent outbound for this
  // conversation. Protects against the model looping phrases across turns.
  let deduped = await filterNonRepeating(input.conversationId, humanized.bubbles);
  if (deduped.length === 0) {
    // Silence is worse than a mild repeat — pick the longest candidate and
    // send it anyway. The model's next turn will pull fresh material.
    const fallback = [...humanized.bubbles].sort((a, b) => b.length - a.length)[0]!;
    logger.warn(
      { ...ctx, original: humanized.bubbles.length },
      "all bubbles flagged as repeats; keeping one to avoid silence",
    );
    deduped = [fallback];
  }
  if (deduped.length < humanized.bubbles.length) {
    logger.debug(
      { ...ctx, before: humanized.bubbles.length, after: deduped.length },
      "dedup dropped bubbles",
    );
  }
  const dedupedHumanized: HumanizedTurn = {
    bubbles: deduped,
    timings: humanized.timings.slice(0, deduped.length),
    totalDurationMs: humanized.timings
      .slice(0, deduped.length)
      .reduce((acc, t) => acc + t.delayMs, 0),
    pacingVariant: humanized.pacingVariant,
  };

  const enqueued = await enqueueHumanizedTurn({
    input,
    humanized: dedupedHumanized,
    llmCallId: llmResult.llmCallId ?? null,
    extraLeadMs: input.extraLeadMs ?? 0,
  });
  await recordRecentBubbles(input.conversationId, enqueued.bubbles);
  await recordRecentEmojis(input.conversationId, emojisOf(enqueued.bubbles));

  logger.info(
    {
      ...ctx,
      bubbleCount: enqueued.bubbles.length,
      totalDurationMs: humanized.totalDurationMs,
      intents: output.detected_intents,
      pitchedAssetId: enqueued.ppvAttemptId ? input.pitch?.asset.id : null,
    },
    "reply enqueued",
  );

  return {
    bubbles: enqueued.bubbles,
    draftMessageIds: enqueued.draftMessageIds,
    ...(llmResult.llmCallId ? { llmCallId: llmResult.llmCallId } : {}),
    ...(enqueued.ppvAttemptId ? { ppvAttemptId: enqueued.ppvAttemptId } : {}),
    phaseTransitionHint: output.phase_transition_hint,
    detectedIntents: output.detected_intents,
    suggestedFacts: output.suggested_facts,
  };
}

async function generateCannedReply(input: GenerateReplyInput): Promise<GenerateReplyResult | null> {
  const rng = seededRng(`${input.conversationId}:cold:${input.turnIndex}`);
  const text = rng.pick(COLD_REPLIES);
  const bubbles = [text];
  const timings = computeTimings(bubbles, rng, { wpm: 80, readTimeMs: 400, readTimeStdMs: 200 });
  const humanized: HumanizedTurn = {
    bubbles,
    timings,
    totalDurationMs: timings[0]?.delayMs ?? 0,
    pacingVariant: pickPacingVariant(input.conversationId),
  };

  const enqueued = await enqueueHumanizedTurn({
    input,
    humanized,
    llmCallId: null,
    extraLeadMs: input.extraLeadMs ?? 0,
  });

  logger.info(
    { conversationId: input.conversationId, turn: input.turnIndex, phase: "COLD" },
    "canned cold reply enqueued",
  );

  return {
    bubbles: enqueued.bubbles,
    draftMessageIds: enqueued.draftMessageIds,
    phaseTransitionHint: null,
    detectedIntents: [],
    suggestedFacts: [],
  };
}

/** Shared tail: insert draft rows, enqueue with cumulative delays. */
async function enqueueHumanizedTurn(args: {
  input: GenerateReplyInput;
  humanized: HumanizedTurn;
  llmCallId: string | null;
  extraLeadMs: number;
}): Promise<{ bubbles: string[]; draftMessageIds: string[]; ppvAttemptId?: string }> {
  const { input, humanized, llmCallId, extraLeadMs } = args;
  const count = humanized.bubbles.length;
  const lastIdx = count - 1;
  const pitch = input.pitch;

  // Sequential (not Promise.all) so created_at is strictly monotonic across
  // bubbles. UI orders messages by created_at and identical timestamps from
  // parallel inserts produced visibly out-of-order rendering.
  const drafts: Array<{ id: string }> = [];
  for (let i = 0; i < humanized.bubbles.length; i++) {
    const draft = await insertOutboundDraft({
      conversationId: input.conversationId,
      text: humanized.bubbles[i]!,
      llmCallId,
      kind: pitch && i === lastIdx ? "ppv" : "text",
    });
    drafts.push(draft);
  }

  // Record the attempt up-front so the send and the rollup are tied even if
  // the outbound send fails later. Unlock tracker resolves it.
  let ppvAttemptId: string | undefined;
  if (pitch) {
    const attempt = await insertPpvAttempt({
      conversationId: input.conversationId,
      assetId: pitch.asset.id,
      priceCents: pitch.priceCents,
      messageId: drafts[lastIdx]!.id,
    });
    ppvAttemptId = attempt.id;
    await Promise.all([
      incrementAttemptCounter(pitch.asset.id),
      bumpAttempt(pitch.asset.id, archetypeSlice(input.archetype ?? null)),
    ]);
  }

  const q = outboundQueue();
  let cumulativeDelay = extraLeadMs;
  for (let i = 0; i < count; i++) {
    cumulativeDelay += humanized.timings[i]?.delayMs ?? 0;
    const isPitchBubble = pitch != null && i === lastIdx;
    const jobData: OutboundJobData = {
      accountId: input.accountId,
      conversationId: input.conversationId,
      subscriberId: input.subscriberId,
      subscriberExternalId: input.subscriberExternalId,
      kind: isPitchBubble ? "ppv" : "text",
      messageId: drafts[i]!.id,
      text: humanized.bubbles[i]!,
      bubbleIndex: i,
      bubbleCount: count,
      ...(isPitchBubble && pitch
        ? {
            ppv: {
              assetId: pitch.asset.id,
              assetRef: resolveAssetRef(pitch.asset),
              priceCents: pitch.priceCents,
            },
          }
        : {}),
    };
    await q.add(`bubble:${drafts[i]!.id}`, jobData, {
      delay: cumulativeDelay,
      jobId: `send-${drafts[i]!.id}`,
    });
  }

  return {
    bubbles: humanized.bubbles,
    draftMessageIds: drafts.map((d) => d.id),
    ...(ppvAttemptId ? { ppvAttemptId } : {}),
  };
}

/** The platform-facing ref (media id / URL) lives in mediaRefs[0] by convention. */
function resolveAssetRef(asset: PpvCatalogRow): string {
  const first = asset.mediaRefs[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "ref" in first) {
    const r = (first as { ref: unknown }).ref;
    if (typeof r === "string") return r;
  }
  return asset.id; // fallback — adapter may treat this as a catalog key
}
