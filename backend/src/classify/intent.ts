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
  /** Specific content the fan asked for (e.g. "feet", "ass", "lingerie", "bj", "video"). null when not specific or no buying signal. Lowercase, single-word when possible. */
  requested_topic: z.string().max(40).nullable().default(null),
  /** Fan is SIGNALING actual payment intent — named a tip amount ("ill tip 50", "drop $100"), promised to pay, or escalated dollars. Distinct from buying_signal which covers any content request. Used to decide whether to offer the $99 custom tier. */
  tipping_intent: z.boolean().default(false),
  /** Fan is asking for a discount or price reduction on a pitch ("any discount?", "lower the price", "can u do it for less", "deal?", "how about $X"). When true the orchestrator knocks 10% off the pitched price and the persona frames it as a one-time gift. */
  discount_request: z.boolean().default(false),
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
  requested_topic: null,
  tipping_intent: false,
  discount_request: false,
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
  `  "requested_topic": string|null,   // SPECIFIC kink/scene/body-part the fan named, normalized to one short lowercase word. ONLY for things that map to specific catalog content. Examples: "feet", "ass", "boobs", "tits", "pussy", "bj", "anal", "lingerie", "shower", "cosplay", "soles", "panties", "ass-clap". DO NOT set this for GENERIC asks like "pic", "video", "teaser", "custom", "exclusive", "something", "more", "content" — those should stay null so the system uses its normal pitch ladder. The point of this field is to override the catalog when the fan named something specific the catalog might not have.`,
  `  "tipping_intent": boolean,       // TRUE when the fan explicitly named a dollar amount tied to a payment verb: "ill tip 50", "drop $100", "tipped 20", "pay you 200", "bump it to 150". Also TRUE on strong promises without exact amount ("ill pay big", "ill tip heavy"). FALSE for generic "ill buy that" without amount, FALSE for casual "tip" mentions without commitment. This flag gates whether the bot offers a $99 custom shoot — only fire when the fan has put real money language on the table.`,
  `  "discount_request": boolean,    // TRUE when the fan asks for a price reduction or discount on a pitch: "can u do a discount?", "any discount babe?", "lower the price", "do it for less", "make it cheaper", "deal?", "discount for me?", "knock it down a bit". Also TRUE for haggling counter-offers like "ill do $0.50 instead" / "how about half off". FALSE for generic price complaints with no ask ("kinda steep", "thats expensive") — those are objections, not discount requests. The orchestrator will knock 10% off the pitched price when this fires.`,
  `  "confidence": number,             // 0..1 how confident the labels are overall`,
  `  "reason": string                  // optional short rationale (<=100 chars)`,
  `}`,
  `Rules:`,
  `- Multiple flags can be true for one message.`,
  `- If the message is just small talk / greeting / compliment with no action request, set all booleans to false and confidence ~0.9.`,
  `- "send me a pic" → buying_signal=true, requested_topic=null (generic — no specific feature).`,
  `- "do you have videos?" → buying_signal=true, requested_topic=null (generic — video is just a format).`,
  `- "got feet?" / "feet pics" / "show me ur feet" → buying_signal=true, requested_topic="feet".`,
  `- "show me ur ass" → buying_signal=true, requested_topic="ass".`,
  `- "wanna see u in lingerie" → buying_signal=true, requested_topic="lingerie".`,
  `- "send something exclusive" / "make it custom" / "i want a teaser" → buying_signal=true, requested_topic=null (no specific feature named).`,
  `- "custom vid of u with a toy" → buying_signal=true, requested_topic="toy" (the "custom" is a generic wrapper; the SPECIFIC feature is "toy").`,
  `- "a custom saying my name" → buying_signal=true, requested_topic="custom_name" (name-personalization is a specific ask the catalog can't satisfy).`,
  `- "something in shower" / "shower vid" → buying_signal=true, requested_topic="shower".`,
  `- "bj content" / "you sucking dick" → buying_signal=true, requested_topic="bj".`,
  `- Rule of thumb: when a fan combines a generic wrapper ("custom", "video", "pic") with a SPECIFIC feature word (a body part, a prop, a scene, a kink, a personalization), set requested_topic to the specific feature. Only null when the ask is purely generic.`,
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
