import { z } from "zod";
import { logger } from "../observability/logger.js";
import { routeLlmCall } from "../llm/router.js";

/**
 * Per-turn inbound intent classification. Runs in parallel with the other
 * turn loads so it adds zero wall-clock latency to the critical path — the
 * main generator call still dominates turn time.
 *
 * Each label answers a specific pipeline question:
 *   buying_signal       → should we pitch this turn?
 *   objection           → should we skip pitching + address the concern?
 *   impossible_request  → should we surface the contract's redirect pattern?
 *   disengagement       → should we keep the reply short and skip pitching?
 *   emotional_disclosure→ should we soften tone + suppress pitch?
 *   ai_question         → did the fan ask if we're AI/real (divert pattern)?
 *
 * A single tiny call returns all six flags, so one classification informs
 * the whole pipeline instead of layering N regex heuristics.
 */

const IntentSchema = z.object({
  buying_signal: z.boolean(),
  objection: z.boolean(),
  impossible_request: z.boolean(),
  disengagement: z.boolean(),
  emotional_disclosure: z.boolean(),
  ai_question: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(200).optional(),
});

export type IntentFlags = z.infer<typeof IntentSchema>;

export const EMPTY_INTENT: IntentFlags = {
  buying_signal: false,
  objection: false,
  impossible_request: false,
  disengagement: false,
  emotional_disclosure: false,
  ai_question: false,
  confidence: 0,
};

const SYSTEM = [
  `You classify the intent of a single inbound message from a fan to an OnlyFans-style chatbot.`,
  `Return JSON only, no prose. Schema:`,
  `{`,
  `  "buying_signal": boolean,         // fan wants content (send it, show me, let me see, i wanna see, what u got, unlock, buy, gimme, drop that, send me something)`,
  `  "objection": boolean,             // too expensive, not my vibe, maybe later, i don't do this, idk, not sure`,
  `  "impossible_request": boolean,    // asks persona to do something a chat-only AI cannot do (lift hands/fingers to prove real, video call right now, take a new pic right now, meet up in person, say their name out loud, proof of humanness)`,
  `  "disengagement": boolean,         // going to bed, gotta go, ttyl, signing off, busy`,
  `  "emotional_disclosure": boolean,  // shares something heavy — breakup, lonely, depressed, death in family, bad day`,
  `  "ai_question": boolean,           // asks "are you real? are you a bot? is this AI? are you human?"`,
  `  "confidence": number,             // 0..1 how confident the labels are overall`,
  `  "reason": string                  // optional short rationale (<=100 chars)`,
  `}`,
  `Rules:`,
  `- Multiple flags can be true for one message.`,
  `- If the message is just small talk / greeting / compliment with no action request, set all booleans to false and confidence ~0.9.`,
  `- "send me a pic" → buying_signal=true. "do you have videos?" → buying_signal=true (they're asking about inventory).`,
  `- "you're pretty / you're hot / i love your body" alone is NOT buying_signal.`,
  `- Be strict: only flag true on clear intent. When unsure, flag false and lower confidence.`,
].join("\n");

/**
 * Classify the fan's latest inbound text. Returns EMPTY_INTENT on any
 * failure — the pipeline treats "no signal" as safe default.
 */
export async function classifyIntent(inboundText: string): Promise<IntentFlags> {
  const text = inboundText.trim();
  if (!text) return EMPTY_INTENT;

  try {
    const result = await routeLlmCall({
      task: "CLASSIFY",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Message:\n"""\n${text}\n"""\n\nClassify.` },
      ],
      responseFormat: "json_object",
      temperature: 0.1,
      maxTokens: 200,
    });
    const parsed = safeJson(result.content);
    if (!parsed.ok) return EMPTY_INTENT;
    const validated = IntentSchema.safeParse(parsed.data);
    if (!validated.success) {
      logger.debug({ err: validated.error.message }, "intent classify — schema mismatch");
      return EMPTY_INTENT;
    }
    return validated.data;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err },
      "intent classify failed; defaulting to empty",
    );
    return EMPTY_INTENT;
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
