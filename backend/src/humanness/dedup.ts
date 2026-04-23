import { sharedRedis } from "../queue/redis.js";

/**
 * Phrase dedup across recent outbound bubbles. The model occasionally falls
 * into a loop ("haha you're so cute", "you're so cute omg", ...) — even with
 * the forbidden phrasebook it can reuse the same openers or close-outs turn
 * after turn. A fan pays attention to repetition, so we explicitly drop
 * bubbles whose 4-gram shingles overlap with recent outbound text.
 *
 * Storage: per-conversation Redis list, capped at N entries (LPUSH + LTRIM).
 * We store normalized text — lowercased, punctuation stripped, whitespace
 * collapsed — so surface variations don't evade the check.
 */

const KEY_PREFIX = "peach:dedup:";
const EMOJI_KEY_PREFIX = "peach:emoji:";
const MAX_ENTRIES = 12;
const MAX_EMOJI_ENTRIES = 8;
const TTL_SEC = 60 * 60 * 24 * 7; // a week — dedup-window decays with the conversation
const SHINGLE_N = 5;
/**
 * How many shared N-grams flag a repeat. 1 was too tight — a single innocuous
 * overlap like "what's your favorite thing" silently killed whole turns.
 * 2 catches real loops without dropping healthy replies.
 */
const MIN_SHINGLE_HIT = 2;

function keyFor(conversationId: string): string {
  return `${KEY_PREFIX}${conversationId}`;
}

function emojiKeyFor(conversationId: string): string {
  return `${EMOJI_KEY_PREFIX}${conversationId}`;
}

/** Load the last N emoji used in this conversation, newest first. */
export async function loadRecentEmojis(conversationId: string): Promise<string[]> {
  const r = sharedRedis();
  return r.lrange(emojiKeyFor(conversationId), 0, MAX_EMOJI_ENTRIES - 1);
}

/** Push emoji into the rolling history (one per bubble that used one). */
export async function recordRecentEmojis(
  conversationId: string,
  emojis: readonly string[],
): Promise<void> {
  if (emojis.length === 0) return;
  const r = sharedRedis();
  const key = emojiKeyFor(conversationId);
  const m = r.multi();
  for (const e of emojis) m.lpush(key, e);
  m.ltrim(key, 0, MAX_EMOJI_ENTRIES - 1);
  m.expire(key, TTL_SEC);
  await m.exec();
}

export function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shinglesOf(text: string, n: number = SHINGLE_N): string[] {
  const tokens = normalizeForDedup(text).split(" ").filter(Boolean);
  if (tokens.length < n) return tokens.length > 0 ? [tokens.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

export async function recordRecentBubble(
  conversationId: string,
  text: string,
): Promise<void> {
  const normalized = normalizeForDedup(text);
  if (normalized.length === 0) return;
  const r = sharedRedis();
  const key = keyFor(conversationId);
  await r
    .multi()
    .lpush(key, normalized)
    .ltrim(key, 0, MAX_ENTRIES - 1)
    .expire(key, TTL_SEC)
    .exec();
}

export async function recordRecentBubbles(
  conversationId: string,
  texts: readonly string[],
): Promise<void> {
  for (const t of texts) {
    // serial so ordering is preserved; volumes are tiny (≤5 bubbles/turn)
    await recordRecentBubble(conversationId, t);
  }
}

/**
 * Return the subset of `candidates` that are *not* duplicates of any recent
 * outbound bubble for this conversation. A candidate is considered a repeat
 * if it shares ≥ MIN_SHINGLE_HIT n-gram with any recent entry, OR if it is
 * a duplicate of an earlier candidate in the same batch.
 */
export async function filterNonRepeating(
  conversationId: string,
  candidates: readonly string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const r = sharedRedis();
  const recent = await r.lrange(keyFor(conversationId), 0, MAX_ENTRIES - 1);
  const seenShingles = new Set<string>();
  for (const entry of recent) {
    for (const s of shinglesOf(entry)) seenShingles.add(s);
  }
  const out: string[] = [];
  for (const c of candidates) {
    const shingles = shinglesOf(c);
    if (shingles.length === 0) {
      // very short bubble (e.g. "lol", "yea") — skip dedup, they're expected to recur
      out.push(c);
      continue;
    }
    let hits = 0;
    for (const s of shingles) {
      if (seenShingles.has(s)) hits++;
      if (hits >= MIN_SHINGLE_HIT) break;
    }
    if (hits >= MIN_SHINGLE_HIT) continue;
    out.push(c);
    // prevent duplicates *within* the same turn too
    for (const s of shingles) seenShingles.add(s);
  }
  return out;
}
