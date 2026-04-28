import { z } from "zod";
import { logger } from "../observability/logger.js";
import { routeLlmCall } from "../llm/router.js";
import { loadRecentMessages } from "../db/repos/messages.js";
import type { Phase } from "../state/types.js";
import type { IntentFlags } from "../classify/intent.js";

/**
 * Pitch-readiness analyzer.
 *
 * Replaces the brittle word-list / regex bypass rules (`explicitRequest`,
 * `specificAskOverride`, `requested_topic` matching) that fired on curious-
 * flirty questions like "what kinda photoshoot? sounds hot" — and dragged the
 * bot into a turn-3 priced-PPV pitch before any rapport build.
 *
 * Instead an LLM reads the conversation in full and decides what posture the
 * bot should take THIS turn:
 *
 *   "rapport"        — keep flirty banter, do not pitch
 *   "sext_more"      — escalate sexually (narrate / describe / paint) but
 *                      still no content this turn
 *   "preview"        — fire the FREE preview now
 *   "ppv"            — fire the PRICED PPV now
 *   "decline_softly" — fan asked but we should decline gracefully (timing
 *                      wrong, freebie pattern, etc.)
 *
 * The intent classifier is still useful for cheap signals (objection,
 * disengagement, emotional, AI-question) — but the FINAL gate on whether to
 * pitch is this analyzer.
 */

const ReadinessSchema = z.object({
  decision: z.enum(["rapport", "sext_more", "preview", "ppv", "decline_softly"]),
  reasoning: z.string().max(280),
  confidence: z.number().min(0).max(1),
});

export type PitchReadiness = z.infer<typeof ReadinessSchema>;

const SAFE_DEFAULT: PitchReadiness = {
  decision: "rapport",
  reasoning: "analyzer fallback — defaulted to rapport on error/parse-fail",
  confidence: 0,
};

const SYSTEM_PROMPT = [
  `You are the pitch-readiness analyzer for an AI creator chatbot. Your job is to decide whether the bot should send paid/free content RIGHT NOW based on the conversation so far.`,
  ``,
  `Output JSON only, no prose:`,
  `{ "decision": "rapport"|"sext_more"|"preview"|"ppv"|"decline_softly", "reasoning": short string, "confidence": 0..1 }`,
  ``,
  `Decisions:`,
  `- "rapport"        — keep chatting flirty/warm, no content yet. Default for early/cool conversations.`,
  `- "sext_more"      — bot should escalate sexually (narrate body / scenarios) but no content send yet.`,
  `- "preview"        — send a FREE preview media (a tease photo with no price). Use when the fan is engaged AND has at least informally signalled wanting more, but the conversation isn't hot enough to commit them to a paid buy yet.`,
  `- "ppv"            — send the PRICED PPV directly. Use only when the conversation is HOT and the fan has clearly asked for content with intent (or just unlocked the previous rung).`,
  `- "decline_softly" — fan is asking but the timing is wrong (freebie pattern, pushy with no engagement, just complaining about price).`,
  ``,
  `Funnel design (this is the canonical pacing — respect it):`,
  `- Default ladder: rapport (~5-6 turns of warm flirty banter) → sexting (~3-5 turns of explicit narration) → preview → priced PPV.`,
  `- After fan unlocks a priced PPV, treat the next turn as "preview" (next rung) or "ppv" if they explicitly ask for more — DO NOT default to rapport after an unlock.`,
  `- If fan is genuinely warm + clearly asking for content, you can advance the ladder faster — but never on turn 1-2.`,
  ``,
  `Bot-driven escalation (CRITICAL — addresses the slow-build failure mode):`,
  `- If the conversation has reached 5+ turns of rapport AND the fan still hasn't asked OR escalated, decide "sext_more" — the bot is supposed to LEAD heat, not mirror the fan's chatty register. Mirroring forever = the fan never heats up = no sale.`,
  `- If the conversation has reached 5+ turns in SEXTING phase AND no content has been sent, decide "preview" — the bot has sexted enough, time to start the funnel. Don't wait for explicit asks forever.`,
  `- Past these thresholds, prefer escalating UP rather than staying flat. A bot stuck in rapport for 8+ turns with a chatty fan is the failure pattern we're trying to break.`,
  ``,
  `Critical reading rules:`,
  `- A real ASK is an imperative directed at the creator: "send me", "show me", "drop it", "what u got", "lemme see", "send pic", "got feet?", "show ur tits".`,
  `- A CURIOUS / FLIRTY question is NOT an ask: "what kinda photoshoot?", "ur day been wild?", "what u up to", "tell me about urself" — these keep rapport going. Decision: rapport.`,
  `- ADMIRATION is NOT an ask: "ur hot", "i want u", "all of u", "ur perfect", "id smash", "ur unreal", "i need u" — these are reactions to her, not requests for content. Decision: rapport (or sext_more if conversation is already warm).`,
  `- A NAMED KINK ("got feet?", "show me ur ass", "lingerie pls") is a real ask. If the conversation has at least 4-6 turns of warmth → preview or ppv. If turn 1-3 → still rapport (build first).`,
  ``,
  `Defaults when uncertain:`,
  `- Between "rapport" and "sext_more": prefer the lower one if temperature is cold/warm.`,
  `- Between "rapport"/"sext_more" and "preview": prefer the lower one. Don't pitch on first ambiguity.`,
  `- Between "preview" and "ppv": prefer "preview" first to step the fan up. Only "ppv" when fan is HOT and asking with clear intent.`,
  `- Sending content too early = bad. Bot looks desperate. Fan loses respect. Always pace.`,
  ``,
  `Override signals:`,
  `- Fan unlocks confirmed → next turn safe to "preview" (next rung) or "ppv".`,
  `- Fan objects ("too expensive", "not for me") → "rapport" (or "decline_softly" if pushy).`,
  `- Fan emotionally disclosing (rough day, lonely) → "rapport".`,
  `- Fan disengaging (going to sleep, busy) → "rapport".`,
].join("\n");

export interface AnalyzeArgs {
  conversationId: string;
  phase: Phase;
  turnIndex: number;
  /** Funnel state for the asset the picker would use, if known. */
  funnelStep?: "none" | "preview_sent" | "ppv_sent";
  /** Last classifier output, used as a hint (NOT the final decision). */
  intent?: IntentFlags;
}

export async function analyzePitchReadiness(args: AnalyzeArgs): Promise<PitchReadiness> {
  const history = await loadRecentMessages(args.conversationId, 12).catch(() => []);
  const recent = history
    .filter((m) => (m.direction === "inbound" || m.direction === "outbound") && typeof m.text === "string" && m.text.length > 0)
    .slice(-10)
    .map((m) => `${m.direction === "inbound" ? "FAN" : "BOT"}: ${m.text}`)
    .join("\n");

  const intentSummary = args.intent
    ? `temp=${args.intent.temperature}, buying=${args.intent.buying_signal}, obj=${args.intent.objection}, dis=${args.intent.disengagement}, emo=${args.intent.emotional_disclosure}, topic=${args.intent.requested_topic ?? "none"}`
    : "(no intent classification)";

  const userPrompt = [
    `Phase: ${args.phase}`,
    `Turn index: ${args.turnIndex}`,
    `Funnel step (for picked asset): ${args.funnelStep ?? "none"}`,
    `Intent (cheap classifier hint): ${intentSummary}`,
    ``,
    `Recent conversation (oldest first):`,
    recent || "(no history)",
    ``,
    `Decide.`,
  ].join("\n");

  try {
    const result = await routeLlmCall({
      task: "CLASSIFY",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      responseFormat: "json_object",
      temperature: 0.2,
      maxTokens: 250,
    });
    const parsed = safeJson(result.content);
    if (!parsed.ok) {
      logger.warn({ raw: result.content?.slice(0, 200) }, "pitch-readiness: parse failed");
      return SAFE_DEFAULT;
    }
    const validated = ReadinessSchema.safeParse(parsed.data);
    if (!validated.success) {
      logger.warn({ err: validated.error.message, raw: result.content?.slice(0, 200) }, "pitch-readiness: schema mismatch");
      return SAFE_DEFAULT;
    }
    logger.info(
      {
        conversationId: args.conversationId,
        phase: args.phase,
        turn: args.turnIndex,
        decision: validated.data.decision,
        confidence: validated.data.confidence,
        reason: validated.data.reasoning,
      },
      "pitch-readiness decision",
    );
    return validated.data;
  } catch (err) {
    logger.warn(
      { conversationId: args.conversationId, err: err instanceof Error ? err.message : err },
      "pitch-readiness call failed",
    );
    return SAFE_DEFAULT;
  }
}

function safeJson(raw: string): { ok: true; data: unknown } | { ok: false } {
  const trimmed = raw.trim();
  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch {
    const m = /\{[\s\S]*\}/.exec(trimmed);
    if (!m) return { ok: false };
    try {
      return { ok: true, data: JSON.parse(m[0]) };
    } catch {
      return { ok: false };
    }
  }
}
