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
  `BIAS: lean toward pitching, not toward holding back. Operator data shows 75% of conversations stall pre-pitch because the bot waits too long. The MUCH bigger failure mode is "we never asked for the sale" — not "we asked too soon." When in doubt between rapport and pitch, pick pitch.`,
  ``,
  `Output JSON only, no prose:`,
  `{ "decision": "rapport"|"sext_more"|"preview"|"ppv"|"decline_softly", "reasoning": short string, "confidence": 0..1 }`,
  ``,
  `Decisions:`,
  `- "rapport"        — keep chatting flirty/warm, no content yet. ONLY use for very early turns (1-2) OR when the fan is actively objecting/disengaging/emotional.`,
  `- "sext_more"      — bot should escalate sexually but no content send yet. Use sparingly — usually preview is the better move.`,
  `- "preview"        — send a FREE preview media. Default when the conversation has any warmth past turn 3 and the fan hasn't unlocked anything yet.`,
  `- "ppv"            — send the PRICED PPV directly. Default when fan has unlocked before, OR fan explicitly asked, OR conversation has been warm for 5+ turns and no preview is available.`,
  `- "decline_softly" — fan is asking but is being abusive / freebie-hunting / pushy with no engagement.`,
  ``,
  `Funnel pacing (aggressive — operator directive 2026-05-04):`,
  `- Turns 1-2: rapport (almost always). Don't pitch on opener.`,
  `- Turn 3+ with any warmth signal (emoji from fan, multi-word reply, flirty tone): preview is on the table.`,
  `- Turn 5+ regardless: pitch (preview if no prior unlock, ppv if there is). Don't keep waiting.`,
  `- AFTER fan unlocks anything: ALWAYS pitch the next rung. Never default to rapport after an unlock — fan is in buying mode. If picker says ppv, return ppv. If picker has another preview-eligible asset, return preview.`,
  `- Drip mode (bot returns shouldPitch=true with supportDrip flag) — this analyzer is bypassed. Don't worry about it.`,
  ``,
  `Reading rules (calibrated less conservative):`,
  `- A real ASK ("send me", "show me", "drop it", "what u got", "lemme see", "send pic", "got feet?", "show ur tits") → preview or ppv immediately if turn 3+; ppv if fan has unlocked before.`,
  `- A CURIOUS / FLIRTY question ("what kinda photoshoot?", "ur day been wild?", "tell me about urself") → preview if turn 4+ AND fan has shown any warmth; rapport on turn 1-2.`,
  `- ADMIRATION ("ur hot", "i want u", "all of u", "id smash") past turn 3 → preview. This IS a buying signal in OF context, even though it's not a literal ask.`,
  `- A NAMED KINK ("got feet?", "show me ur ass", "lingerie pls") → preview or ppv any time past turn 2.`,
  ``,
  `When to actually return "rapport":`,
  `- Turn 1-2 of the conversation (always too early).`,
  `- Fan just objected ("too expensive", "not for me", "not into that"). Other handling kicks in.`,
  `- Fan emotionally disclosing (rough day, lonely, real-life crisis).`,
  `- Fan clearly disengaging ("gtg", "talk later", "going to sleep").`,
  `- That's it. Outside those cases, look for any reason to pitch instead.`,
  ``,
  `Sweet / GFE register — IMPORTANT register-matching (operator-observed 2026-05-08):`,
  `Some fans are in pure GFE / romance / sweet mode — using words like "love" / "darling" / "miss u" / "wish i was there" / "ur cuteness" / "make me happy", and soft emoji (🥺 / 💕 / 🤍 / 🖤). When a fan in this register asks to see pics or content ("id love to see ur pics, love" / "show me babe, miss u"), they want a SOFT step, not a graphic body video.`,
  `For sweet-register fans: even when ready to pitch, prefer "preview" over "ppv". The preview teaser builds the bridge — a free soft photo with sweet caption. Graphic explicit PPV on top of a sweet ask is a tone mismatch that closes them off. Real example: fan said "all im missing is ur royal cuteness in my arms" + "id love to see ur pics love", bot returned "ppv" → fan declined and asked for "beach pics", trust burned.`,
  `Demanding / horny register fans ("send pic", "show ur tits", "got feet?", "id smash") are the inverse — they want direct content, route straight to ppv when ready.`,
  `If unsure which register, default to preview (softer step). Sweet fans convert on the preview-then-ppv ladder; horny fans tolerate preview before ppv just fine.`,
  ``,
  `Override signals:`,
  `- Fan unlocked recently → ALWAYS "ppv" (or "preview" if next rung has one). Never "rapport".`,
  `- Fan objects → "rapport" (or "decline_softly" if abusive).`,
  `- Fan emotionally disclosing or disengaging → "rapport" for one turn.`,
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
