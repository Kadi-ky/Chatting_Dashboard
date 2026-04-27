import { z } from "zod";

/**
 * Structured JSON the generator must return every turn. Parsed strictly;
 * violations trigger one retry with a stricter schema reminder, then fallback
 * provider. Keep the field list small and additive — breaking changes force
 * prompt-cache invalidation across all personas.
 */
export const generatorOutputSchema = z.object({
  /** Ordered message bubbles. Each bubble is one platform DM. 1–3 is the norm. */
  bubbles: z.array(z.string().min(1).max(600)).min(1).max(5),

  /** Optional humanness hints the model may emit; post-processor overrides if absent. */
  delay_ms_before_first: z.number().int().min(0).max(600_000).nullable().optional(),
  gap_ms_between_bubbles: z.number().int().min(0).max(60_000).nullable().optional(),

  /** Free-form intent tags the model detected in the inbound. Used for analytics + state. */
  detected_intents: z.array(z.string().min(1).max(64)).max(10).default([]),

  /** Durable facts the model wants persisted. confidence 0..1. */
  suggested_facts: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        value: z.string().min(1).max(500),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(6)
    .default([]),

  /** Model-suggested state transition. The state machine may ignore it. */
  phase_transition_hint: z
    .enum(["WARMUP", "RAPPORT", "QUALIFYING", "MONETIZING", "WHALE", "REACTIVATION", "COLD"])
    .nullable()
    .default(null),

  /** If the model refuses to reply (contract violation), populate this — caller decides. */
  refusal_reason: z.string().max(500).nullable().default(null),
});

export type GeneratorOutput = z.infer<typeof generatorOutputSchema>;

/** Human-readable description of the contract, injected into the TASK layer. */
export const GENERATOR_OUTPUT_SPEC = `Return a single JSON object, no markdown, no code fences. Shape:
{
  "bubbles": string[],                 // 1..5 DM bubbles, each <=600 chars. ALWAYS at least 1 bubble — never empty.
  "delay_ms_before_first": number|null,
  "gap_ms_between_bubbles": number|null,
  "detected_intents": string[],        // short tags e.g. "asking_for_pic", "price_objection"
  "suggested_facts": [{"key":"location","value":"dallas","confidence":0.8}],
  "phase_transition_hint": "WARMUP"|"RAPPORT"|"QUALIFYING"|"MONETIZING"|"WHALE"|"REACTIVATION"|"COLD"|null,
  "refusal_reason": string|null        // ONLY for hard CONTRACT-layer violations: underage, illegal acts, mental-health crisis. NEVER for soft declines like "I don't have that kink content" or "I won't move off-platform" — for those, send a graceful in-character bubble instead. Silence is worse than a soft no.
}
Only output the JSON. No preamble, no trailing commentary.`;
