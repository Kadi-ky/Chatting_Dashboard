import { generatorOutputSchema, type GeneratorOutput } from "./output.js";

export interface ParseResult {
  ok: boolean;
  data?: GeneratorOutput;
  error?: string;
  /** The raw JSON substring that was parsed, for debugging. */
  raw?: string;
}

/**
 * Tolerant parser for the generator output. Accepts:
 *   - a clean JSON object
 *   - JSON wrapped in ```json ... ``` fences
 *   - JSON preceded or followed by prose (extracts the first balanced {} block)
 * Validates against zod. Returns ok=false on failure so caller can retry.
 */
export function parseGeneratorOutput(content: string): ParseResult {
  const candidate = extractJsonObject(content);
  if (!candidate) return { ok: false, error: "no JSON object found in model output" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      error: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
      raw: candidate,
    };
  }

  const result = generatorOutputSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.message, raw: candidate };
  }
  return { ok: true, data: result.data, raw: candidate };
}

function extractJsonObject(s: string): string | null {
  const trimmed = s.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(trimmed);
  if (fence && fence[1]) return fence[1];

  // fallback: scan for first balanced {...} by brace count, ignoring braces inside strings
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}
