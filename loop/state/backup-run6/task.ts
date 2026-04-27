import { GENERATOR_OUTPUT_SPEC } from "../output.js";

export type GeneratorTaskKind =
  | "reply"
  | "tease"
  | "pitch"
  | "objection_handle"
  | "decline"
  | "reactivation"
  | "broadcast";

export interface TaskLayerInput {
  kind: GeneratorTaskKind;
  /** Free-form objective the state machine computed. Rendered verbatim. */
  objective: string;
  /** Hard don'ts for this turn (phase-dependent). Bullet list style. */
  forbiddens?: string[];
  /** Optional context the model needs to act (e.g. asset title + price for a pitch). */
  details?: Record<string, string | number | null | undefined>;
  /**
   * Per-turn guidance that must win recency weight over the cached prefix.
   * Rendered as a final block before the output spec — the closest thing to
   * the model's next token and hardest to ignore. Example: the anti-mirror
   * directive listing words the fan just used.
   */
  turnGuidance?: string;
}

/**
 * L8 — TASK. Per-turn objective + output spec. This is the one layer that
 * changes every turn and is injected last so the model sees it fresh.
 */
export function buildTaskLayer(input: TaskLayerInput): string {
  const lines: string[] = [];
  lines.push(`# This turn`);
  lines.push(`Task kind: ${input.kind}`);
  lines.push(``);
  lines.push(`Objective: ${input.objective}`);

  if (input.forbiddens && input.forbiddens.length > 0) {
    lines.push(``);
    lines.push(`Do not:`);
    for (const f of input.forbiddens) lines.push(`- ${f}`);
  }

  if (input.details) {
    const entries = Object.entries(input.details).filter(([, v]) => v !== undefined && v !== null);
    if (entries.length > 0) {
      lines.push(``);
      lines.push(`Details:`);
      for (const [k, v] of entries) lines.push(`- ${k}: ${String(v)}`);
    }
  }

  if (input.turnGuidance && input.turnGuidance.trim().length > 0) {
    lines.push(``);
    lines.push(input.turnGuidance.trim());
  }

  lines.push(``);
  lines.push(`# Output`);
  lines.push(GENERATOR_OUTPUT_SPEC);

  return lines.join("\n");
}
