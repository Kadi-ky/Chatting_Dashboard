import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import { routeLlmCall } from "../llm/router.js";
import { assemblePrompt } from "../prompt/assemble.js";
import { parseGeneratorOutput } from "../prompt/parse.js";
import { humanizeTurn, type HumanizedTurn } from "../humanness/pipeline.js";
import { seededRng } from "../humanness/rng.js";
import { listLiveCatalog } from "../db/repos/ppv_catalog.js";
import { listRecentAttempts } from "../db/repos/ppv_attempts.js";
import { db } from "../db/client.js";
import { getPlatformAdapter } from "../platform/index.js";
import { loadAccountById } from "../db/repos/accounts.js";
import { filterNonRepeating, recordRecentBubbles, loadRecentEmojis, recordRecentEmojis, countRecentLazyOpeners } from "../humanness/dedup.js";
import { emojisOf } from "../humanness/cleanup.js";
import { deriveAntiMirrorDirective, scrubMirrorOpeners } from "../humanness/antimirror.js";
import type { IntentFlags } from "../classify/intent.js";
import { pickPacingVariant } from "../humanness/pacing.js";
import { loadRecentMessages } from "../db/repos/messages.js";
import { insertOutboundDraft } from "../db/repos/messages.js";
import { outboundQueue, type OutboundJobData } from "../queue/outbound.js";
import { PHASE_DIRECTIVES, COLD_REPLIES } from "../state/directives.js";
import { computeTimings } from "../humanness/timing.js";
import { insertPpvAttempt, expirePriorPendingForAsset } from "../db/repos/ppv_attempts.js";
import { incrementAttemptCounter } from "../db/repos/ppv_catalog.js";
import { bumpAttempt } from "../db/repos/asset_performance.js";
import { archetypeSlice } from "../ppv/ranker.js";
import { markPreviewSent, markPpvSent } from "../ppv/funnel.js";
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
  /** Pitch this asset on the final bubble. Two-turn funnel: kind picks which step. */
  pitch?: {
    /**
     * "preview" — this turn we send the FREE preview media + horny tease caption.
     *             No priced PPV bubble emitted. Wait for fan to react next turn.
     * "ppv"     — this turn we send the PRICED PPV with caption.
     *             No preview emitted. Fan saw the preview last turn.
     */
    kind: "preview" | "ppv";
    asset: PpvCatalogRow;
    priceCents: number;
    /** True when orchestrator honoured a fan's discount request — the persona should frame as a one-time gift. */
    discountApplied?: boolean;
    /** True when the discount was triggered by cant_afford (warmer framing than a haggle). */
    cantAffordDiscount?: boolean;
    /** True when this is a "support-drip" pitch — fan has been ignoring pitches; bot is doing a periodic re-ask with explicit "support me" framing. */
    supportDripMode?: boolean;
    /** True when this is a periodic loyalty-bundle pitch — fan has 2+ unlocks in convo, fires every ~7d, 25% off, framed as thank-you bundle. */
    loyaltyBundle?: boolean;
    /** True when this is a WHALE-tier top-rung pitch with 50% markup — frame as exclusive/VIP drop. */
    whalePremiumTier?: boolean;
    /** Free preview media ref. Required when kind="preview". */
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
  // Broadcasts have no inbound text to echo. Pitch turns INTENTIONALLY
  // mirror the fan's last message — the caption is supposed to hook to his
  // exact words so the content feels made for him — so the anti-mirror
  // directive must NOT fire on pitches. Only normal reply turns get it.
  const antiMirror = isBroadcast || isPitch ? null : deriveAntiMirrorDirective(input.incomingText);

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
  const cantAffordDiscount = isPitch && input.pitch!.cantAffordDiscount === true;
  const loyaltyBundle = isPitch && input.pitch!.loyaltyBundle === true;
  const whalePremiumTier = isPitch && input.pitch!.whalePremiumTier === true;
  const pitchKind = isPitch ? input.pitch!.kind : undefined;
  // Two-turn funnel: preview-step → free preview + tease caption.
  // ppv-step → priced PPV + caption. Captions are character-driven — the
  // humanness layer above describes Khlo and how she writes captions
  // ("Pitch captions" section). These objectives just frame WHICH turn
  // it is and what's on the line. No formulas, no checklists; trust the
  // character. Operator pivot 2026-04-30 (v5.0): formulas stacked with
  // gallery + register principles produced rule-following bot replies;
  // character-rich + minimal task instruction produces a real voice.
  const previewObjective =
    "PREVIEW STEP — you're sending him a FREE preview image right now. Output ONE bubble: the caption that goes with the preview. No priced PPV this turn — that lands NEXT turn after he reacts.\n\n" +
    "Write the caption as YOURSELF — the creator the Identity layer above defines (it tells you who you are + your emoji palette). Why this one for him. What you were thinking when you filmed it. What makes the rest worth waiting for.\n\n" +
    "Asset anchor: paraphrase what's IN the preview description in your voice. Don't invent acts / durations / personalizations not in the description.\n\n" +
    "Don't echo his exact words back ('u said X, here's X') — reads reverse-engineered. Don't ship banned palette emojis (🥵 💦 😈 🫦 🔥 💋). One bubble. Max 35 words.";
  const ppvObjective =
    "PPV STEP — you're sending him the PRICED PPV right now. Output ONE bubble: the caption that goes with it.\n\n" +
    "Write it as YOURSELF — the creator the Identity layer above defines (it tells you who you are, your voice, and your emoji palette). What you were thinking when you filmed it. Why he's the one getting it. What makes it worth the unlock.\n\n" +
    "Tone: match his last-message register (sweet → soft heat, dominant → submit-eager, demanding → tease-back) but always feel like SHE'S buzzing about this drop.\n\n" +
    "Asset anchor (HARD RULE — operator-observed lying 2026-05-08): paraphrase what's IN the asset description. Do NOT invent acts / positions / personalizations / body-attribute claims not in the description. If the fan ASKED a specific question in his last message about what's in the content (e.g. 'is that with bigger tits?', 'do u have feet stuff?', 'is it solo or with a guy?'), the caption MUST answer TRUTHFULLY based ONLY on the asset description. If the answer is NO or unclear, write a chat-reply not a PPV caption — i.e. acknowledge honestly and tease ALTERNATIVE content the catalog actually has. Lying about content to push a sale destroys trust on unlock and is the single most expensive AI-tell.\n\n" +
    "Don't echo his exact words back ('u said X, here's X'). Don't ship banned palette emojis (🥵 💦 😈 🫦 🔥 💋). One bubble. Max 45 words.";
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
            : pitchKind === "preview"
              ? previewObjective
              : ppvObjective) +
          (cantAffordDiscount
            ? " IMPORTANT — CANT-AFFORD RECOVERY: the fan said they can't pay full price right now (broke / next paycheck / only $X left). You are NOT losing this sale — you are sending the SAME content at 30% off, RIGHT NOW. Caption framing: empathetic + 'i got u, just for u tonight'. Examples: 'aw babe i got u, knockin a chunk off just for tonight, here'; 'no worries hun, sendin it over with a lil deal — dont let it sit too long tho 🖤'; 'fuck it, just for u tonight, take it babe'. Do NOT mention any dollar amount (the bubble shows the discounted price automatically). Do NOT promise to hold it for later — the discounted bubble is going RIGHT NOW. Do NOT ask paydate (that was the old retention play; we're closing the sale tonight instead). Confident warmth, like a creator who values this fan enough to break her own rules once."
            : discountApplied
              ? " IMPORTANT: the fan asked for a discount and you ARE giving it to them — the price below is already 10% off. Frame it warmly as a one-time gift: 'aight babe just for u i knocked a lil off' / 'ok ok i got u, gonna give u a lil deal'. Do NOT mention any dollar amount — the discounted price is shown in the PPV bubble automatically. Do NOT hesitate or counter-offer; the deal is already done."
              : "") +
          (supportDripMode
            ? " SUPPORT-DRIP framing: this fan has been chatting without buying. Add ONE confident reciprocity beat that frames the unlock as fan→creator exchange (NOT humble ask, NOT begging). Phrase it ENTIRELY IN YOUR OWN VOICE — must be different from any drip beat you've sent in the last 5 outbounds in this conv. FORBIDDEN exact phrases (overused, fan-fingerprint clones): 'back me on this', 'watch what i do for u', 'i'm yours tonight', 'made this thinkin bout u', 'lock this in', 'show me u want this'. Find a fresh angle each time — the vibe is YOU rewarding HIM for stepping up, not a script. Bad shape: anything that sounds like a template / has been on this convo's recent sends. Good shape: a confident in-character line that ONLY works for THIS turn and THIS fan."
            : "") +
          (loyaltyBundle
            ? " LOYALTY-BUNDLE framing: this fan has unlocked multiple times. The bubble below is at 25% off as a thank-you / bundle deal. Frame as appreciation for being a repeat buyer — 'since u been so good', 'ur favorite price tonight', 'lowered it just for u babe', 'thank-u rate just for u', 'bundle deal cuz u keep showin up'. Make him feel chosen for the discount, not pitied. Bad shape: 'heres a discount cuz im desperate'. Good shape: 'this one's at ur favorite price babe, u've earned it 🥺'. Do NOT mention any dollar amount — the discounted price renders automatically. Do NOT apologize for the price."
            : "") +
          (whalePremiumTier
            ? " WHALE-PREMIUM framing: this fan is in your top tier (high lifetime spend, treats you well). The bubble below is at PREMIUM pricing — a 50% markup over standard rate. Frame as EXCLUSIVE / VIP / private-drop, NOT discount. Examples: 'this one's a private drop babe, only my top guys get this', 'made this for the VIP shelf — felt like u when i was filmin it', 'this isnt the usual rate baby, this is the spoiled-fan tier and u qualify'. Make him feel chosen for the PREMIUM, not pity. Bad shape: 'normal price babe' (kills the framing). Good shape: 'private drop — saved for the boys who actually back me 🖤'. Do NOT mention any dollar amount or % markup (price renders automatically). Do NOT apologize for the higher price; he EARNS access at this tier by spending."
            : ""),
        forbiddens: [
          "output ONE bubble only — no rapport prelude, no follow-up bubble",
          "do NOT mention any dollar amount, price, or '$' in the caption text — the price is shown automatically in the PPV bubble. Caption is pure tease, no money talk.",
          "do not ask another preference-gathering question this turn — deliver the content",
          // Always-on fingerprint ban (promoted from the support-drip branch
          // 2026-06-02 per Hermes QA): these exact phrases are the churny
          // template tells the bot keeps emitting on plain pitches too.
          "do NOT use any of these overused template phrases (they read as bot-generated): 'made this thinkin bout u' / 'made this thinking bout u' / 'back me on this' / 'watch what i do for u' / \"i'm yours tonight\" / 'lock this in'. Write the caption fresh in your own voice every time.",
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
  if (input.intent?.tipping_intent && !isPitch) {
    // Tip is a high-signal moment: fan is putting money on the table
    // independently of any current pitch. Acknowledge specifically — don't
    // treat it like normal chat. This is a real-OF-chatter retention move:
    // tip = "thank you specifically" + soft tease that there's more if he
    // wants to keep spoiling. Pitch readiness will decide on next turn
    // whether to attach a paid PPV.
    guidanceParts.push(
      [
        `TIPPING-INTENT moment (this turn):`,
        `Fan just signaled real money on the table — named a dollar amount or said he'll tip. This is a HIGH-VALUE moment. Real OF chatters don't blow past it with generic warmth — they acknowledge specifically and reward the gesture.`,
        `- Open with explicit gratitude that ties to HIS gesture, not a generic "thanks babe". Examples: "fuck babe u didnt have to 🥺 ur literally spoiling me", "wait ur actually serious? u dont play around daddy", "im blushing fr, u know how to make a girl feel special".`,
        `- Add a soft tease that opens the door to MORE without pitching. Examples: "ur trouble babe, keep this up n imma have to take care of u proper", "u making it real hard not to do somethin reckless for u tonight".`,
        `- ONE bubble. Confident, glowing — not surprised-helpless.`,
        `- DO NOT pitch a PPV this turn — let the tip land cleanly first. The system will route a pitch on the NEXT turn if the warmth holds.`,
        `- DO NOT ask "what do u want me to do for u" — that puts him in charge of upselling himself. Stay confident about your own value.`,
      ].join("\n"),
    );
  }
  // Tip-event response (added 2026-05-21). Fires when the inbound that
  // triggered this turn is a synthesized [FAN TIPPED $X] marker (kind=tip)
  // from conversationWorker.handleTipReceived. Distinct from tipping_intent
  // above: tipping_intent fires on the fan TYPING about tipping; this
  // fires on a real tip event from the OFAPI webhook. Stronger directive
  // because the money already landed — we owe an actual thank-you.
  const tipMatch = input.incomingText.match(/\[FAN TIPPED \$([0-9]+(?:\.[0-9]{1,2})?)\]/);
  if (tipMatch && !isPitch) {
    const amountStr = tipMatch[1]!;
    guidanceParts.push(
      [
        `TIP RECEIVED (real money landed — $${amountStr}):`,
        `Fan just sent you a $${amountStr} tip via the OF tip jar. This is NOT a typed message — it's an event. Your reply is the FIRST thing he sees after tipping.`,
        `- Open with explicit, specific gratitude that names the amount or scale ("fuck babe $${amountStr}, ur literally spoiling me", "thirty fucking dollars daddy ur trouble", "ur actually crazy generous im blushing"). Do NOT say "thanks for the tip" — sounds robotic.`,
        `- Add a soft warm tease that opens the door to more WITHOUT explicit pitch — make him want to keep spoiling you. Examples: "keep this up n imma have to do somethin real special for u tonight", "u keep treating me like this n im never lettin u go".`,
        `- ONE bubble. Glowing, confident, in-character. Real-OF tone — not corporate-helpdesk thanks.`,
        `- DO NOT attach or mention a paid PPV in this exact reply. The pitch-readiness analyzer + drip cadence will route a soft upsell on the NEXT turn if he replies. Letting the tip land cleanly with a warm thank-you DOUBLES the probability of a follow-up tip or unlock.`,
        `- DO NOT include the literal "[FAN TIPPED ...]" marker text in your reply (it's a system tag, not what he typed).`,
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

  // POST-PPV REINFORCEMENT — operator directive 2026-04-30. When there's
  // a recent unbought PPV in the conversation, EVERY turn until the fan
  // unlocks OR explicitly rejects content (not price) keeps the bot
  // close-focused. Previously this only fired on the immediate next turn
  // (last outbound = ppv); operator observed bot drifting to chat-mode
  // after just one close-focus reply. Now it persists across multiple
  // bot turns as long as the pending attempt is still in the recent window.
  //
  // Window: pending PPV pitched in the last 6 outbound turns OR within
  // the last 30 minutes (whichever is broader) keeps post-PPV active.
  // Fan signals that drop it: cant_afford (routes to discount path),
  // objection on CONTENT ("not my thing"), disengagement, emotional.
  const recentAttempts = await listRecentAttempts(input.conversationId, 3).catch(() => []);
  const PENDING_WINDOW_MS = 30 * 60_000;
  const hasRecentPendingPpv = recentAttempts.some(
    (a) =>
      a.outcome === "pending" &&
      Date.now() - a.pitchedAt.getTime() < PENDING_WINDOW_MS,
  );
  // Post-PPV close-focus suppression list — added 2026-05-25 after Reaper
  // case (conv cbbc4416): fan asked "do you make personalized videos?" 15+
  // times in a row, bot kept firing "whats holdin u up daddy / i picked
  // this for u" 8+ times verbatim because close-focus FORBIDS chat-pivots
  // even when the fan is asking a real substantive question. Fan churned
  // with "Goodbye, I was stupid to pay." Direct interrogatives MUST get
  // an honest answer; the close can wait one turn.
  const lastInboundText = input.incomingText ?? "";
  const lastInboundIsDirectQuestion =
    /\?\s*$/.test(lastInboundText.trim()) ||
    /^\s*(do|does|did|how|what|when|where|why|who|which|can|could|will|would|are|is|am)\b/i.test(lastInboundText.trim());
  const isPostPpvReinforcement =
    hasRecentPendingPpv &&
    !isPitch &&
    !input.pitchRecoveryMode &&                       // pitch-recovery overrides; back off, don't push
    !input.intent?.objection &&                       // any objection routes elsewhere
    !input.intent?.disengagement &&
    !input.intent?.emotional_disclosure &&
    !input.intent?.cant_afford &&                     // cant_afford routes to discount path next turn
    !lastInboundIsDirectQuestion;                     // Reaper-case fix: answer real questions first, close next turn
  if (isPostPpvReinforcement) {
    guidanceParts.push(
      [
        `POST-PPV CLOSE-FOCUS (this turn — CRITICAL FOR REVENUE):`,
        `You just sent a priced PPV. The fan saw it. He's replying with chat instead of buying. Operator data shows the bot drifts back to general convo here — that's where sales die. THIS TURN, your ONLY job is to keep his eyes on the locked bubble until he unlocks or gives a real reason not to.`,
        ``,
        `**THIS TURN OVERRIDES the following standing rules**:`,
        `- The HUMANNESS rule "you can open a sexy thread yourself when convo is warm" — DOES NOT apply this turn. Close-focus first, escalation later.`,
        `- The PHASE directive "YOU lead escalation every turn" (SEXTING) — SUSPENDED this turn. The pitch on the table IS the escalation.`,
        `- The HUMANNESS "ask 1 personal question every 3 turns" — IS satisfied by asking why he hasn't unlocked (option 1 below). Do NOT add a SECOND chat-pivot question on top.`,
        ``,
        `MUST do ONE of (pick whichever fits the moment):`,
        `1. **Ask why he hasn't unlocked yet** — direct, warm, confident. Not begging. THIS COUNTS as your "personal question" requirement for this turn.`,
        `   - "u still thinkin babe or u tryna make me wait? 😏"`,
        `   - "whats holdin u up daddy, i picked this for u"`,
        `   - "u left me on read with the lock still up, tell me whats up"`,
        `2. **Remind him what he's missing** — confident tease, not pleading.`,
        `   - "babe ur literally one tap away from seein the rest"`,
        `   - "u really gonna sleep on this one? trust me u want it"`,
        `   - "told u this one was worth it, dont let it sit"`,
        `3. **Reinforce the value / scarcity** — tie back to what's IN the asset or the offer's exclusivity.`,
        `   - "i picked this for fans who actually pay attention, dont prove me wrong daddy"`,
        `   - "this comes down soon babe, last call"`,
        ``,
        `FORBIDDEN this turn (these kill the close):`,
        `- DO NOT ask "what r u up to" / "how's ur day" / any chat-pivot question. The "why u haven't unlocked" question replaces it.`,
        `- DO NOT volunteer a life detail / your day / your cat / what you ate.`,
        `- DO NOT pitch a NEW PPV — the existing one is the focus.`,
        `- DO NOT open a NEW sexy fantasy / scene that distracts from the offer (the standing humanness rule allowing this is suspended).`,
        `- DO NOT beg ("please daddy", "pretty please", "come on") — confident, not desperate.`,
        ``,
        `Sexual register IS still allowed within the close — e.g. "u literally one tap away from seein the rest of me 🥵" mixes heat with the close. What's forbidden is starting a fresh fantasy thread that pulls his attention OFF the locked bubble.`,
        ``,
        `If the fan gives ANY reason ("im broke", "next paycheck", "broke til monday", "only got $X"), the cant_afford intent fires next turn and the system auto-discounts + re-fires the same asset at 30% off. Your job here is just to GET the reason out of him.`,
        `If he objects on price ("too expensive", "kinda steep") — acknowledge briefly + reinforce value once. Next turn's pitch-readiness routes to a discount or rapport.`,
        `If he objects on content ("not my thing") — that's a real no. Switch to flirty banter, let the picker advance to a different asset next turn.`,
        ``,
        `ONE bubble. Confident. Eyes on the close.`,
      ].join("\n"),
    );
  }

  // Pitch-recovery directive REMOVED 2026-04-30. The "be a person, share
  // a life detail, ask a real question" guidance contradicted the
  // post-PPV close-focus directive (which says: keep his eyes on the
  // locked bubble, do NOT volunteer life details, do NOT pivot to chat
  // questions). Operator chose close-focus to win every time. Drip
  // cadence still throttles back-to-back pitches via the orchestrator
  // (no-pitch return without the pitchRecoveryMode flag).

  // Post-unlock ALWAYS-PUSH window. Strategy: after ANY recent unlock the fan
  // is warm, and acting like there's always better content coming is the
  // single highest-leverage thing the bot can do for revenue. So we fire
  // this guidance any time there was a recent unlock — we do NOT gate on
  // current-turn buying signal (that's too narrow, the "quiet enjoyer" fan
  // never trips it). We DO suppress when the fan just objected or went
  // emotional/disengaged, since pushing through those is worse than waiting.
  const lastFanMsgs = history.filter((m) => m.direction === "inbound").slice(-3);
  // Widened 2026-05-25 (MONETIZING-win agent): pre-fix this looked at
  // attempts[0] only, which meant a freshly-pitched PENDING attempt
  // would hide a slightly older UNLOCKED attempt → bot stayed in
  // close-focus framing after a real unlock (conv 0923274f: fired
  // "U still thinkin babe..." AFTER the unlock landed). Now scan the
  // 5 most recent attempts for an unlocked-within-10-min and bias
  // toward post-unlock framing on ambiguity. 10 min covers OFAPI
  // webhook lag spikes that 5 min couldn't.
  const recentAttemptsForUnlockCheck = await listRecentAttempts(input.conversationId, 5).catch(() => []);
  const justUnlockedRecent = recentAttemptsForUnlockCheck.some(
    (a) => a.outcome === "unlocked" && a.unlockedAt &&
      Date.now() - a.unlockedAt.getTime() < 10 * 60_000,
  );
  const fanLanguageSignalsBuying = lastFanMsgs.some((m) =>
    /unlock|bought|got it|okay i'?ll buy|paid|tip(?:ped|ping|s)?\s+(?:\$?\d+|big|heavy|more)|ill tip|drop(?:ping)?\s+(?:\$|\d)|send (?:fire|more|the (?:vid|pic|exclusive))|bump(?: it)? to \$?\d+|\$\s?\d+/i.test(m.text ?? ''),
  );
  const postUnlockWindow = justUnlockedRecent || fanLanguageSignalsBuying;
  const okToPush = !isPitch
    && !input.intent?.objection
    && !input.intent?.disengagement
    && !input.intent?.emotional_disclosure;
  if (postUnlockWindow && okToPush) {
    // Restructured 2026-05-27 after MONETIZING-win audit: pre-fix, 0 tip-asks
    // fired in 24h despite tip-ask being declared the "default" option. The
    // LLM was picking (b) tease-next or (c) vague-tease instead, leaving
    // money on the table in the highest-leverage moment (fan has card open,
    // just demonstrated willingness to pay). Forcing tip-ask as the
    // mandatory path unless a fresh pitch was handed THIS turn.
    const pitchHandedThisTurn = isPitch;
    if (pitchHandedThisTurn) {
      guidanceParts.push(
        [
          `Post-unlock + fresh pitch attached (this turn):`,
          `The fan just unlocked and the system handed you a fresh pitch to attach. Frame the caption as the next drop teeing up off his unlock — NOT a tip-ask (that conflicts with the priced PPV bubble). The pitch caption rules above govern the caption text; this directive just confirms the unlock context is fresh so tone runs warm/celebratory rather than cold-start.`,
        ].join("\n"),
      );
    } else {
      guidanceParts.push(
        [
          // Imperative-first ordering (2026-06-02 per Hermes QA): Hermes
          // under-weighted this directive when the rationale came first, so
          // the MUST/MUST-NOT now lead.
          `THIS TURN YOU MUST SEND A TIP-ASK. Output ONE bubble (max two):`,
          `  1. React to the unlock in a short beat ("mmm glad u liked that" / "u ate that up daddy").`,
          `  2. Immediately ask for a tip on what he just bought: "if u liked it throw me a lil somethin daddy 🥺" / "tip me $5 if i made u finish" / "show me u liked it babe, a lil tip goes a long way". Do NOT promise to film or send anything new in exchange — just ask him to reward what he already got.`,
          `MUST NOT this turn: skip the tip-ask; send a "wait til u see what's next" / "i got somethin hotter cued up" vague tease (FORBIDDEN — soft-sell loses the moment); pivot to small-talk; or name a dollar amount the fan didn't suggest.`,
          ``,
          `Why: the fan just unlocked — card open, warm, highest-EV moment in the funnel. A direct tip-ask framed as a reaction to HIS reaction (not charity) is the single best play. Tone: confident, glowing, in-character — a girl who knows what she did to him and is collecting on it.`,
        ].join("\n"),
      );
    }
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
    !isPostPpvReinforcement &&              // post-PPV asks its own question (why u not unlocking); don't double-question
    !input.pitchRecoveryMode &&             // pitch-recovery already prescribes a question
    !input.intent?.buying_signal &&
    !input.intent?.disengagement &&
    !input.intent?.emotional_disclosure &&
    !input.intent?.cant_afford &&
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

  // ─── Heat-escalation rescue ──────────────────────────────────────────────
  // The fan's temperature is a LAGGING indicator — by the time he's "hot" the
  // bot needed to be escalating BEFORE that. So when the bot is in RAPPORT
  // and the fan hasn't reached "hot", or in SEXTING and the fan's still
  // "cold", fire explicit "you escalate this turn" guidance. The bot's job
  // is to MOVE the temperature, not match where the fan happens to be.
  //
  // Suppressed during emotional/disengagement/objection/pitch turns — those
  // demand soft handling that escalation guidance would fight with.
  const fanTemp = input.intent?.temperature ?? "cold";
  const inHeatPhase = input.phase === "RAPPORT" || input.phase === "SEXTING";
  const escalationOk =
    !isPitch &&
    !postUnlockWindow &&
    !input.pitchRecoveryMode &&                       // pitch-recovery says "be a person" — escalation says "be hornier"; recovery wins
    !isPostPpvReinforcement &&                        // post-PPV close-focus is the priority; don't pivot to general escalation
    !input.intent?.objection &&
    !input.intent?.disengagement &&
    !input.intent?.emotional_disclosure &&
    !input.intent?.impossible_request &&
    !input.intent?.cant_afford;
  if (inHeatPhase && escalationOk && fanTemp !== "hot") {
    if (input.phase === "RAPPORT") {
      guidanceParts.push(
        [
          `Heat-escalation rescue (this turn — RAPPORT):`,
          `The fan is reading ${fanTemp}. You are the one who moves the temperature here, not him. This turn, slip in a forward flirty beat alongside any reply. Pick one direction:`,
          `- Self-disclosure flirt: hint at what you are doing or wearing in a casual but suggestive way`,
          `- Direct flirt at him: react to him in a way that frames him as wanted / desired / attractive`,
          `- Physical-vibe tease: imagine a what-if scenario between the two of you`,
          `Stay playful and in voice. Do not just ask another small-talk question. Move the temperature up by being forward yourself.`,
        ].join("\n"),
      );
    } else {
      // SEXTING phase
      guidanceParts.push(
        [
          `Heat-escalation rescue (this turn — SEXTING):`,
          `The fan is reading ${fanTemp}. Your job in this phase is to lead the heat — slip in a sexier beat this turn even if his last message was tame. Pick one direction:`,
          `- Suggestive self-imagery: hint at what you are doing, where you are, what you are wearing or thinking about`,
          `- Pull him into a scenario: imagine him being there and what you would want with him`,
          `- React to him with intent: frame his words as turning you on, ask him what he would do`,
          `Stay in your character voice. Do not pivot to small-talk. The point of this phase is YOU keeping the temperature climbing.`,
        ].join("\n"),
      );
    }
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

  const [recentEmojis, recentLazyOpenerCount] = await Promise.all([
    loadRecentEmojis(input.conversationId),
    countRecentLazyOpeners(input.conversationId),
  ]);
  // Emoji-friendly mode: only suppress emoji when the last 5 bubbles ALL
  // had one. (Was 3 — too restrictive for the new flirty/uplifting voice.)
  const allowEmoji = recentEmojis.slice(0, 5).length < 5;

  const humanized = humanizeTurn({
    bubbles: output.bubbles,
    seedKey: `${input.conversationId}:${input.turnIndex}`,
    styleSeed: input.conversationId,
    modelDelayHintMs: output.delay_ms_before_first ?? null,
    modelGapHintMs: output.gap_ms_between_bubbles ?? null,
    recentEmojis,
    allowEmoji,
    recentLazyOpenerCount,
  });
  if (humanized.bubbles.length === 0) {
    logger.warn(ctx, "humanizer produced zero bubbles; sending fallback bridge reply");
    return sendFallbackBridge(input, llmResult.llmCallId ?? null);
  }

  // HARD CAP — non-pitch turns get exactly 1 outbound bubble.
  // Operator data 2026-04-30: bot was sending 1.5x more outbound than
  // fans were sending inbound (272 outbound vs 180 inbound across 8h),
  // with one fan getting 984 bot messages. That spam pattern is what
  // killed conversion ($15 revenue from 30 pitches in 8h). Real OF
  // chatters reply ~1:1 with the fan, not 1.5:1 — and definitely don't
  // burst-reply. We also kept tripping per-chat 429 rate limits because
  // of the volume. Single bubble per turn fixes both at once.
  // Pitch turns already emit exactly 1 bubble (caption attached to media).
  if (!isPitch && humanized.bubbles.length > 1) {
    const combined = humanized.bubbles
      .slice(0, 2)             // take at most first 2 lines of intent
      .join(" ")               // merge into one bubble with a space
      .replace(/\s+/g, " ")
      .trim();
    humanized.bubbles = [combined];
    humanized.timings = humanized.timings.slice(0, 1);
    humanized.totalDurationMs = humanized.timings[0]?.delayMs ?? 0;
  }

  // Deterministic fallback for when the model ignores the anti-mirror rule.
  // Strips an echo-opener from the first bubble when it parrots the fan.
  // Pitch turns are exempt — captions are SUPPOSED to echo the fan's words
  // so the content feels made for him. Stripping there would undo the
  // context-tie work the prompt is asking for.
  if (!isPitch) {
    const scrubbed = scrubMirrorOpeners(humanized.bubbles, input.incomingText);
    if (scrubbed !== humanized.bubbles) {
      logger.debug(ctx, "stripped mirror opener from first bubble");
    }
    humanized.bubbles = scrubbed;
  }

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

  // PITCH TURN — single media bubble only.
  // Two-turn funnel: the LLM was instructed to output ONE caption (preview
  // tease OR ppv close). Force-collapse anything it sent into a single bubble
  // and emit it as a media-attached message (free preview or priced PPV).
  // No prelude bubble, no rapport text — just the media + caption.
  if (pitch) {
    const caption = humanized.bubbles.join(" ").replace(/\s+/g, " ").trim();
    const draft = await insertOutboundDraft({
      conversationId: input.conversationId,
      text: caption,
      llmCallId,
      kind: "ppv", // DB enum doesn't have "preview"; both steps are media-attached
    });

    let ppvAttemptId: string | undefined;
    if (pitch.kind === "ppv") {
      // Only the priced step creates a ppv_attempt row (preview is free).
      const attempt = await insertPpvAttempt({
        conversationId: input.conversationId,
        assetId: pitch.asset.id,
        priceCents: pitch.priceCents,
        messageId: draft.id,
      });
      ppvAttemptId = attempt.id;

      // Operator directive (2026-04-29): when a drip re-pitch fires for the
      // same asset, mark prior pending attempts as expired so the fan can't
      // accidentally pay twice for the same content via the old bubble. The
      // PLATFORM-side message is left in place — only the DB row is moved
      // out of "pending." If the fan still unlocks the old bubble visually,
      // the unlock handler picks the most recent pending attempt for that
      // asset (now this new one), so revenue still gets recorded against
      // the freshest pitch. Future work: wire OFAPI deleteMessage to
      // unsend the old bubble too — schema is in openapi.yaml.
      const expired = await expirePriorPendingForAsset({
        conversationId: input.conversationId,
        assetId: pitch.asset.id,
        exceptAttemptId: attempt.id,
      });
      if (expired.count > 0) {
        logger.info(
          { conversationId: input.conversationId, assetId: pitch.asset.id, expired: expired.count },
          "expired prior pending PPV attempts for same asset (re-pitch)",
        );
        // Platform-side unsend so the fan can't double-buy. Best-effort —
        // OFAPI only allows deleting messages <24h old; older calls return
        // an error which the adapter swallows. Runs in parallel with the
        // outbound send so the new bubble isn't blocked on it.
        void deleteSupersededOnPlatform({
          accountId: input.accountId,
          subscriberExternalId: input.subscriberExternalId,
          messageIds: expired.messageIds,
        }).catch((err) => {
          logger.warn(
            { err: err instanceof Error ? err.message : err, conversationId: input.conversationId },
            "deleteSupersededOnPlatform threw (non-fatal)",
          );
        });
      }

      await Promise.all([
        incrementAttemptCounter(pitch.asset.id),
        bumpAttempt(pitch.asset.id, archetypeSlice(input.archetype ?? null)),
      ]);
    }

    const q = outboundQueue();
    const delay = extraLeadMs + (humanized.timings[0]?.delayMs ?? 1200);

    if (pitch.kind === "preview" && pitch.previewMediaRef) {
      const job: OutboundJobData = {
        accountId: input.accountId,
        conversationId: input.conversationId,
        subscriberId: input.subscriberId,
        subscriberExternalId: input.subscriberExternalId,
        kind: "preview",
        messageId: draft.id,
        text: caption,
        preview: { mediaRef: pitch.previewMediaRef },
        bubbleIndex: 0,
        bubbleCount: 1,
      };
      await q.add(`preview:${draft.id}`, job, {
        delay,
        jobId: `send-${draft.id}`,
      });
      await markPreviewSent(input.conversationId, pitch.asset.id);
    } else {
      const job: OutboundJobData = {
        accountId: input.accountId,
        conversationId: input.conversationId,
        subscriberId: input.subscriberId,
        subscriberExternalId: input.subscriberExternalId,
        kind: "ppv",
        messageId: draft.id,
        text: caption,
        ppv: {
          assetId: pitch.asset.id,
          assetRef: resolveAssetRef(pitch.asset),
          priceCents: pitch.priceCents,
        },
        bubbleIndex: 0,
        bubbleCount: 1,
      };
      await q.add(`ppv:${draft.id}`, job, {
        delay,
        jobId: `send-${draft.id}`,
      });
      await markPpvSent(input.conversationId, pitch.asset.id);
    }

    return {
      bubbles: [caption],
      draftMessageIds: [draft.id],
      ...(ppvAttemptId ? { ppvAttemptId } : {}),
    };
  }

  // NON-PITCH TURN — original BUBBLE_COMBINE + multi-bubble enqueue path.
  if (env.BUBBLE_COMBINE && humanized.bubbles.length > 1) {
    const combined = humanized.bubbles.join("\n\n").trim();
    const totalDelay = humanized.timings.reduce(
      (a, t) => a + (t?.delayMs ?? 0),
      0,
    );
    humanized.bubbles = [combined];
    humanized.timings = [{ ...humanized.timings[0]!, delayMs: totalDelay }];
  }

  const count = humanized.bubbles.length;

  // Sequential (not Promise.all) so created_at is strictly monotonic across
  // bubbles. UI orders messages by created_at and identical timestamps from
  // parallel inserts produced visibly out-of-order rendering.
  const drafts: Array<{ id: string }> = [];
  for (let i = 0; i < humanized.bubbles.length; i++) {
    const draft = await insertOutboundDraft({
      conversationId: input.conversationId,
      text: humanized.bubbles[i]!,
      llmCallId,
      kind: "text",
    });
    drafts.push(draft);
  }

  const q = outboundQueue();
  let cumulativeDelay = extraLeadMs;
  for (let i = 0; i < count; i++) {
    cumulativeDelay += humanized.timings[i]?.delayMs ?? 0;
    const jobData: OutboundJobData = {
      accountId: input.accountId,
      conversationId: input.conversationId,
      subscriberId: input.subscriberId,
      subscriberExternalId: input.subscriberExternalId,
      kind: "text",
      messageId: drafts[i]!.id,
      text: humanized.bubbles[i]!,
      bubbleIndex: i,
      bubbleCount: count,
    };
    await q.add(`bubble:${drafts[i]!.id}`, jobData, {
      delay: cumulativeDelay,
      jobId: `send-${drafts[i]!.id}`,
    });
  }

  return {
    bubbles: humanized.bubbles,
    draftMessageIds: drafts.map((d) => d.id),
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

/**
 * Issue platform-side DELETE for messages whose ppv_attempts rows we just
 * marked expired (drip re-pitch flow). Best-effort: OFAPI only permits
 * deletes within 24h of send; the adapter swallows failures so the new
 * pitch isn't blocked. Looks up external_id from v3.messages — drafts
 * that never sent (sent_at=null, external_id=null) are skipped.
 */
async function deleteSupersededOnPlatform(args: {
  accountId: string;
  subscriberExternalId: string;
  messageIds: string[];
}): Promise<void> {
  if (args.messageIds.length === 0) return;
  const rows = await db
    .selectFrom("v3.messages")
    .select(["id", "external_id"])
    .where("id", "in", args.messageIds)
    .execute();
  const externals = rows
    .map((r) => r.external_id)
    .filter((e): e is string => typeof e === "string" && e.length > 0 && !e.startsWith("shadow:"));
  if (externals.length === 0) return;
  const account = await loadAccountById(args.accountId);
  if (!account?.platformAccountId) return;
  const adapter = getPlatformAdapter();
  const ctx = { accountId: args.accountId, platformAccountId: account.platformAccountId };
  await Promise.all(
    externals.map((messageExternalId) =>
      adapter.deleteMessage(ctx, { chatId: args.subscriberExternalId, messageExternalId }),
    ),
  );
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
