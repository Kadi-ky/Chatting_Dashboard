import type { Rng } from "./rng.js";
import type { StyleProfile } from "./style.js";

export interface TimingOptions {
  /** Target words-per-minute of the persona. Default 60 (or style.wpm when provided). */
  wpm?: number;
  /** Standard deviation on wpm (per-bubble jitter). Default 10. */
  wpmStd?: number;
  /** Minimum read-time before a reply starts, in ms. Default 800. */
  readTimeMs?: number;
  /** Standard deviation on read-time, in ms. Default 600. */
  readTimeStdMs?: number;
  /** Hard ceiling on per-bubble typing time, in ms. Default 45_000 (45s). */
  maxBubbleMs?: number;
  /** Hard floor on per-bubble typing time, in ms. Default 800. */
  minBubbleMs?: number;
  /** Extra pause between bubbles beyond typing time. Default 400ms + jitter. */
  interBubbleGapMs?: number;
  /** Per-conversation style — supplies wpm default. */
  style?: StyleProfile;
}

export interface BubbleTiming {
  /** ms to wait before sending this bubble, relative to the previous bubble's send time. */
  delayMs: number;
}

/** word count approximation for timing (not tokens, actual words). */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Compute per-bubble send delays that mimic a person typing. The first bubble
 * gets a read-time lead-in; subsequent bubbles only get typing time + a small
 * gap. Deterministic given rng so the same conversation replays the same
 * rhythm (useful for debugging and style consistency).
 */
export function computeTimings(bubbles: string[], rng: Rng, opts: TimingOptions = {}): BubbleTiming[] {
  const wpm = opts.wpm ?? opts.style?.wpm ?? 60;
  const wpmStd = opts.wpmStd ?? 10;
  const readTimeMs = opts.readTimeMs ?? 800;
  const readTimeStdMs = opts.readTimeStdMs ?? 600;
  const maxBubbleMs = opts.maxBubbleMs ?? 45_000;
  const minBubbleMs = opts.minBubbleMs ?? 800;
  const interBubbleGapMs = opts.interBubbleGapMs ?? 400;

  return bubbles.map((b, i) => {
    const effectiveWpm = Math.max(15, rng.gaussian(wpm, wpmStd));
    const words = wordCount(b);
    const typingMs = (words / effectiveWpm) * 60_000;
    const lead =
      i === 0 ? Math.max(0, rng.gaussian(readTimeMs, readTimeStdMs)) : interBubbleGapMs + rng.gaussian(0, 200);
    const raw = typingMs + lead;
    const clamped = Math.max(minBubbleMs, Math.min(maxBubbleMs, raw));
    return { delayMs: Math.round(clamped) };
  });
}
