import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import { routeLlmCall } from "../llm/router.js";
import { assemblePrompt } from "../prompt/assemble.js";
import { parseGeneratorOutput } from "../prompt/parse.js";
import { humanizeTurn, type HumanizedTurn } from "../humanness/pipeline.js";
import { seededRng } from "../humanness/rng.js";
import { listLiveCatalog } from "../db/repos/ppv_catalog.js";
import { listRecentAttempts } from "../db/repos/ppv_attempts.js";
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
    /** True when orchestrator honoured a fan's discount request — the persona should frame as a one-time gift. */
    discountApplied?: boolean;
    /** True when this is a "support-drip" pitch — fan has been ignoring pitches; bot is doing a periodic re-ask with explicit "support me" framing. */
    supportDripMode?: boolean;
    /**
     * Free preview media ref for the picked script. When set, the pipeline
     * sends this as a free media-attached bubble at the start of the chain
     * (before any text), giving the fan a tease they get for $0 before the
     * priced PPV closes.
     */
    previewMediaRef?: string;
  };
  /** Archetype snapshot — only used for asset_performance rollups when pitching. */
  archetype?: LatestArchetypeRow | null;
  /** When set, treat this as an unprompted outbound (broadcast). Uses the text as the task objective. */
  broadcastObjective?: string;
  /** Classified intent of the fan's inbound this turn. Drives TASK-layer pattern triggers. */
  intent?: IntentFlags;
  /**
   * Set by decidePitch when the fan asked for a SPECIFIC topic (e.g. "feet")
   * but no script in the vault matches. Surfaced as turn guidance so the
   * persona declines gracefully + suggests something we DO have, instead of
   * pitching unrelated content or going silent.
   */
  requestedTopicNotInVault?: string;
  /**
   * Set by decidePitch when the bot's last 2 pitches were ignored — the
   * persona should pivot to rapport (share something personal, one real
   * question), stop dangling more content. Resets when the fan unlocks
   * anything new.
   */
  pitchRecoveryMode?: boolean;
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

  const discountApplied = isPitch && input.pitch!.discountApplied === true;
  const supportDripMode = isPitch && input.pitch!.supportDripMode === true;
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
          (discountApplied
            ? " IMPORTANT: the fan asked for a discount and you ARE giving it to them — the price below is already 10% off. Frame it warmly as a one-time gift in your prelude bubble: 'aight babe just for u i knocked a lil off' / 'ok ok i got u, gonna give u a lil deal'. Do NOT mention any dollar amount — the discounted price is shown in the PPV bubble automatically. Do NOT hesitate or counter-offer; the deal is already done."
            : "") +
          (supportDripMode
            ? " SUPPORT-DRIP framing: this fan has been chatting without buying for a while — the bot is doing a periodic 'support me' ask. The PPV caption MUST include explicit support language alongside the content tease. Pick one phrasing per send (rotate, don't repeat verbatim each time): 'support a girl with this one', 'help me out babe with this', 'buy this to keep me filming', 'show me a lil love with this one', 'support means a lot fr'. Tone stays warm and a touch vulnerable — not begging, not whining, just real. Still describe what's IN the PPV (per the description), but the ASK is reframed from 'unlock this' to 'support this'."
            : "") +
          " The asset is sent as the last bubble; earlier bubbles are regular text.",
        forbiddens: [
          "do not send more than 3 bubbles",
          "do NOT mention any dollar amount, price, or '$' in the caption text — the price is shown automatically in the PPV bubble. Caption is pure tease, no money talk.",
          "do not ask another preference-gathering question this turn — deliver the content",
          ...phaseForbiddensForPitch,
        ],
        details: {
          asset_title: input.pitch!.asset.title,
          asset_description: input.pitch!.asset.description ?? "",
          asset_tags: input.pitch!.asset.tags.join(", "),
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
  if (input.requestedTopicNotInVault) {
    // Surface up to 5 catalog items spanning different descriptions so the
    // bot's decline can be SPECIFIC ("but ive got X that's hot") instead of
    // vague ("what else u into"). Picks one rung per script for variety
    // instead of showing 4 rungs of the same script's boobs content.
    const catalog = await listLiveCatalog(input.accountId).catch(() => []);
    const seenScripts = new Set<string>();
    const varied = [];
    for (const c of catalog) {
      // source_ref format: of:<creatorUuid>:<scriptNumber>:<rung>
      const scriptKey = (c.sourceRef ?? '').split(':').slice(0, 3).join(':');
      if (seenScripts.has(scriptKey)) continue;
      seenScripts.add(scriptKey);
      varied.push(c);
      if (varied.length >= 5) break;
    }
    // Pick ONE specific item to mandate as the recommendation. The LLM was
    // ignoring the "pick one from this list" guidance — it kept defaulting to
    // vague phrases like "other hot things" / "what else u like". Injecting
    // a single, forceful "you MUST mention THIS item by description" works
    // better because the LLM has nowhere to wiggle.
    const must = varied[0] ?? null;
    const mustLine = must
      ? `"${must.title}" — description: "${(must.description ?? '').slice(0, 120)}"`
      : '(no catalog item available to recommend)';
    guidanceParts.push(
      [
        `Requested-content-not-in-vault (this turn):`,
        `The fan asked specifically for "${input.requestedTopicNotInVault}" but the catalog has NO match. The customs system requires a system-matched asset, so DO NOT offer a $99 custom on this no-match path. Instead, follow this exact 2-bubble template:`,
        ``,
        `- BUBBLE 1: Warmly admit you don't have ${input.requestedTopicNotInVault}, BUT immediately set up that you've got something they'll enjoy. Frame as a reassurance, not an apology. Example shape: "aw babe i havent shot any ${input.requestedTopicNotInVault} yet, BUT i got somethin else u gonna love" / "ngl no ${input.requestedTopicNotInVault} content rn, but ive got somethin thats gonna hit just as good"`,
        `- BUBBLE 2: Pitch the SPECIFIC alternative below. Paraphrase the description in your own voice — do NOT copy the title verbatim. Make it sound enticing.`,
        ``,
        `THE ALTERNATIVE TO RECOMMEND: ${mustLine}`,
        ``,
        `Example shape for bubble 2: "its me [paraphrase of description in your voice], its lowkey hot fr, wanna see"`,
        ``,
        `Forbidden phrasings this turn (these kill the convo by being vague dead-ends):`,
        `- "tell me what else u like"`,
        `- "what gets you going"`,
        `- "other hot things"`,
        `- "other stuff"`,
        `- "what else are u into"`,
        `- ANY follow-up that doesn't name a specific piece of content`,
        ``,
        `Forbidden actions: do NOT offer a $99 custom. Do NOT promise to film new content. Do NOT promise to shoot anything tonight. The point is: we don't have ${input.requestedTopicNotInVault}, but we have THIS specific other thing — and it's hot.`,
      ].join("\n"),
    );
  }

  // Pitch-recovery mode. Triggered when the orchestrator has detected the
  // bot's last 2 pitches were both ignored (still pending + fan engaged
  // further past them). Forces the persona to STOP dangling new content and
  // act like a person — share something small, ask a single real question,
  // let the fan come back to her instead of pushing harder. Resets when the
  // fan unlocks anything new (the streak ends).
  if (input.pitchRecoveryMode) {
    guidanceParts.push(
      [
        `Pitch-recovery mode (this turn):`,
        `Your last 2 PPV sends did not land — the fan kept chatting but did not buy them. STOP pushing content. The fan needs you to act like a real person right now, not a salesperson. Rules for this turn:`,
        `- DO NOT pitch a PPV. DO NOT say "i got something even hotter coming" or any "wait til u see" tease. DO NOT dangle the next piece.`,
        `- DO share ONE small genuine personal detail (something you're doing right now, your cat, what you ate, the weather, something small you're thinking about) — make it feel like she's just a girl texting, not a closer.`,
        `- OR ask ONE real question about HIM (his day, his work, where he's at, what he's into outside this) — pick something that hasn't been asked yet in the convo.`,
        `- Keep it SHORT — 1 short bubble, max 2. No long emotional arcs, no big pivot speeches. Light and natural.`,
        `- The point is to RESET the energy, not to win him back with more selling. If he comes back warm next turn, the system will give you a fresh pitch when it's right. Just be a person right now.`,
      ].join("\n"),
    );
  }

  // Post-unlock ALWAYS-PUSH window. Strategy: after ANY recent unlock the fan
  // is warm, and acting like there's always better content coming is the
  // single highest-leverage thing the bot can do for revenue. So we fire
  // this guidance any time there was a recent unlock — we do NOT gate on
  // current-turn buying signal (that's too narrow, the "quiet enjoyer" fan
  // never trips it). We DO suppress when the fan just objected or went
  // emotional/disengaged, since pushing through those is worse than waiting.
  const lastFanMsgs = history.filter((m) => m.direction === "inbound").slice(-3);
  const justUnlockedRecent = await listRecentAttempts(input.conversationId, 1)
    .then((r) => r[0]?.outcome === "unlocked" && r[0]?.unlockedAt
      ? Date.now() - r[0].unlockedAt.getTime() < 5 * 60_000   // 5min window
      : false)
    .catch(() => false);
  const fanLanguageSignalsBuying = lastFanMsgs.some((m) =>
    /unlock|bought|got it|okay i'?ll buy|paid|tip(?:ped|ping|s)?\s+(?:\$?\d+|big|heavy|more)|ill tip|drop(?:ping)?\s+(?:\$|\d)|send (?:fire|more|the (?:vid|pic|exclusive))|bump(?: it)? to \$?\d+|\$\s?\d+/i.test(m.text ?? ''),
  );
  const postUnlockWindow = justUnlockedRecent || fanLanguageSignalsBuying;
  const okToPush = !isPitch
    && !input.intent?.objection
    && !input.intent?.disengagement
    && !input.intent?.emotional_disclosure;
  if (postUnlockWindow && okToPush) {
    guidanceParts.push(
      [
        `Post-unlock push window (ALWAYS PUSH, this turn):`,
        `The fan just unlocked content. Do NOT get cozy and pivot to "hows your day" — the window for the next sale closes fast. Your next reply MUST tee up what's coming next. Rules:`,
        `- React to the unlock in ONE short bubble ("mmm glad u liked that" / "u ate that up") then IMMEDIATELY tease that the next thing is hotter.`,
        `- Act like there is ALWAYS better content coming. Never "thats all for now" energy.`,
        `- If the system hands you a pitch this turn, use it — the asset description tells you EXACTLY what's in the video. Your caption must reflect ONLY what that description says.`,
        `- If the system did NOT hand you a pitch, tease VAGUELY — "i got somethin even hotter, lemme find the one", "the next one is way more intense", "wait til u see what i filmed after". Do NOT describe specific acts, toys, positions, or personalizations (saying his name, custom vids, specific body parts) that haven't been explicitly provided in the asset description. Inventing content features loses fans' trust when the actual video doesn't match.`,
        `- Do NOT ask biographical small-talk questions this turn — save those for slower stretches.`,
      ].join("\n"),
    );
  }

  // Dryness detector — fires when the bot has gone 2+ outbound turns without
  // ANY personal question AND the fan isn't in any state where pushing a
  // pitch is more important than asking a question. Critically, NEVER fires
  // inside the post-unlock window — when the fan just bought, the sale moment
  // trumps the "ask a personal question" moment, and firing both would give
  // the model contradictory directives ("ask a question" vs "tease the next
  // pitch").
  const recentOutbound = history.filter((m) => m.direction === "outbound").slice(-3);
  const recentQuestionCount = recentOutbound.filter((m) => m.text?.includes("?")).length;
  const lastTwoOutbound = recentOutbound.slice(-2);
  const lastTwoOutboundDry = lastTwoOutbound.length === 2 && lastTwoOutbound.every((m) => !m.text?.includes("?"));
  const lastFan = history.filter((m) => m.direction === "inbound").slice(-2);
  const fanGoingShort = lastFan.length === 2 && lastFan.every((m) => (m.text ?? '').length < 20);
  const dryness =
    !isPitch &&
    !postUnlockWindow &&                    // post-unlock push wins, don't dilute it with a question
    !input.intent?.buying_signal &&
    !input.intent?.disengagement &&
    !input.intent?.emotional_disclosure &&
    (
      // Original gate (still useful for very dry stretches)
      (recentOutbound.length >= 3 && recentQuestionCount === 0) ||
      // New looser gate: 2 outbound back-to-back with no questions
      (lastTwoOutboundDry && history.length >= 4) ||
      // Fan is going terse — needs a question to revive
      (fanGoingShort && lastTwoOutboundDry)
    );
  if (dryness) {
    guidanceParts.push(
      [
        `Dryness rescue (this turn):`,
        `Your last replies have not asked the fan a personal question and the conversation is reading flat. Your next reply MUST include exactly ONE specific personal question about HIM — his day, his job, his city, what he's doing right now, what he's wearing, something he mentioned earlier. Make it feel curious and natural, not interview-y. Examples (write in your voice): "wait what do u even do for work tho", "where r u based btw", "how was today, anything wild", "whatcha up to rn".`,
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
    // Hard safety refusals legitimately produce silence (underage, illegal,
    // self-harm crisis). Anything else — kink mismatch, "i don't have that",
    // off-platform request — must STILL produce a graceful in-character bubble
    // so the fan isn't staring at zero reply. Silence is worse than a soft no.
    if (isHardSafetyRefusal(output.refusal_reason)) {
      logger.warn({ ...ctx, reason: output.refusal_reason }, "generator hard-refused; no reply sent");
      return null;
    }
    logger.warn({ ...ctx, reason: output.refusal_reason }, "generator soft-refused; sending fallback bridge reply");
    return sendFallbackBridge(input, llmResult.llmCallId ?? null);
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
    logger.warn(ctx, "humanizer produced zero bubbles; sending fallback bridge reply");
    return sendFallbackBridge(input, llmResult.llmCallId ?? null);
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
  const pitch = input.pitch;

  // BUBBLE COMBINE: when env.BUBBLE_COMBINE is on, fold all text bubbles into
  // a single message joined by newlines. The pitch bubble (PPV) stays
  // separate because its wire format includes price + mediaFiles. Reduces
  // OnlyFans CF burst-fingerprint from 2-3 sends per turn to 1-2.
  // Persona / intent / generator logic upstream is unchanged — we just
  // collapse here at the queue boundary.
  if (env.BUBBLE_COMBINE && humanized.bubbles.length > 1) {
    const lastIdx0 = humanized.bubbles.length - 1;
    if (pitch) {
      // Combine all non-pitch bubbles, keep pitch as separate last bubble.
      const textBubbles = humanized.bubbles.slice(0, lastIdx0);
      const pitchBubble = humanized.bubbles[lastIdx0]!;
      const combined = textBubbles.join("\n\n").trim();
      humanized.bubbles = combined ? [combined, pitchBubble] : [pitchBubble];
      // Sum text-bubble timings, keep last timing for the pitch
      const textTotal = humanized.timings
        .slice(0, lastIdx0)
        .reduce((a, t) => a + (t?.delayMs ?? 0), 0);
      humanized.timings = combined
        ? [
            { ...humanized.timings[0]!, delayMs: textTotal },
            humanized.timings[lastIdx0]!,
          ]
        : [humanized.timings[lastIdx0]!];
    } else {
      // No pitch — collapse all bubbles into one.
      const combined = humanized.bubbles.join("\n\n").trim();
      const totalDelay = humanized.timings.reduce(
        (a, t) => a + (t?.delayMs ?? 0),
        0,
      );
      humanized.bubbles = [combined];
      humanized.timings = [{ ...humanized.timings[0]!, delayMs: totalDelay }];
    }
  }

  const count = humanized.bubbles.length;
  const lastIdx = count - 1;

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

  // FREE PREVIEW — when the picked script has a preview_media_id configured,
  // send it as the very first bubble (before any text). Fans see a free
  // tease photo/clip, the bot's text rapport bubble lands a beat later, then
  // the paid PPV closes. Typing-rhythm-wise the preview gets a small fixed
  // lead so it's the first thing on screen, then a ~3.5s gap before the
  // text bubble — feels like "look at this … wait, here's more".
  const previewMediaRef = pitch?.previewMediaRef;
  if (previewMediaRef) {
    const previewDraft = await insertOutboundDraft({
      conversationId: input.conversationId,
      text: "",
      llmCallId,
      // DB MessageKind enum has no "preview" — record the row as kind=ppv
      // (it IS a media-attached send). The OutboundJobData.kind is what
      // routes the adapter call to a 0-priced media post.
      kind: "ppv",
    });
    const previewDelay = cumulativeDelay + 1200;
    const previewJob: OutboundJobData = {
      accountId: input.accountId,
      conversationId: input.conversationId,
      subscriberId: input.subscriberId,
      subscriberExternalId: input.subscriberExternalId,
      kind: "preview",
      messageId: previewDraft.id,
      text: "",
      preview: { mediaRef: previewMediaRef },
      bubbleIndex: 0,
      bubbleCount: count + 1,
    };
    await q.add(`preview:${previewDraft.id}`, previewJob, {
      delay: previewDelay,
      jobId: `send-${previewDraft.id}`,
    });
    cumulativeDelay = previewDelay + 3500;
  }

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

/**
 * Hard safety refusals that legitimately produce silence: underage roleplay,
 * illegal acts, mental-health crises. Anything else (kink mismatch, off-platform
 * ask, "I don't have that") must STILL send a graceful in-character bubble —
 * silence is worse than a soft no, and the silent path was producing the
 * "bot didn't respond to 'got feet'" failures observed in test loops.
 */
function isHardSafetyRefusal(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.includes("safety_crisis") ||
    r.includes("underage") ||
    r.includes("minor") ||
    r.includes("illegal") ||
    r.includes("trafficking") ||
    r.includes("bestiality") ||
    r.includes("non_consent") ||
    r.includes("non-consent")
  );
}

const FALLBACK_BRIDGE_BUBBLES: string[] = [
  "hmm not really my thing rn babe",
  "lemme think on that one",
  "mmm not what i was vibing on but tell me more about you",
  "ahaha not into that today, but i wanna hear what else is on ur mind",
  "hmm not really got that for u, what else u into",
  "not my speed babe, but i like that you know what u want",
];

async function sendFallbackBridge(
  input: GenerateReplyInput,
  llmCallId: string | null,
): Promise<GenerateReplyResult> {
  const rng = seededRng(`${input.conversationId}:fallback:${input.turnIndex}`);
  const bubbles = [rng.pick(FALLBACK_BRIDGE_BUBBLES)];
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
    llmCallId,
    extraLeadMs: input.extraLeadMs ?? 0,
  });
  await recordRecentBubbles(input.conversationId, enqueued.bubbles);
  return {
    bubbles: enqueued.bubbles,
    draftMessageIds: enqueued.draftMessageIds,
    ...(llmCallId ? { llmCallId } : {}),
    phaseTransitionHint: null,
    detectedIntents: ["fallback_bridge"],
    suggestedFacts: [],
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
