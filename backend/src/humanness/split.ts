import type { Rng } from "./rng.js";

export interface SplitOptions {
  /** Soft max chars per bubble. Default 280. */
  maxChars?: number;
  /** Hard cap on bubbles per turn. Default 5. */
  maxBubbles?: number;
}

/**
 * Safety-net bubble splitter. The generator is instructed to return bubbles
 * already split, but if it ignores that, this splits on sentence boundaries
 * without cutting mid-sentence. Also trims / normalizes whitespace and drops
 * empty bubbles.
 */
export function normalizeBubbles(
  bubbles: string[],
  _rng: Rng,
  opts: SplitOptions = {},
): string[] {
  const maxChars = opts.maxChars ?? 280;
  const maxBubbles = opts.maxBubbles ?? 5;

  const out: string[] = [];
  for (const b of bubbles) {
    const cleaned = b
      .replace(/—/g, ",") // em-dash -> comma (belt-and-suspenders vs L3 humanness rule)
      .replace(/;/g, ",")
      .replace(/[\s ]+/g, " ")
      .trim();
    if (cleaned.length === 0) continue;
    if (cleaned.length <= maxChars) {
      out.push(cleaned);
      continue;
    }
    // sentence-ish split, keeping delimiters
    const parts = cleaned
      .split(/(?<=[.!?])\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    let buffer = "";
    for (const p of parts) {
      if ((buffer + " " + p).trim().length > maxChars) {
        if (buffer) out.push(buffer.trim());
        buffer = p;
      } else {
        buffer = buffer ? `${buffer} ${p}` : p;
      }
    }
    if (buffer) out.push(buffer.trim());
  }

  return out.slice(0, maxBubbles);
}
