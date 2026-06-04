import type { Rng } from "./rng.js";

/**
 * Deterministic post-cleanup that enforces the humanness rules the model is
 * most likely to violate (trailing "lol"/"haha", emoji sprinkle, 3-bubble
 * reflex). Prompt rules catch most cases; this is the safety net for the rest.
 */

// Trailing filler tokens the model loves to sign off with. Case-insensitive,
// with optional trailing punctuation. We keep them mid-sentence — only the
// *final* instance on a bubble is stripped, and only probabilistically so a
// rare genuine "lol" at the end survives.
const TRAILING_FILLER_RE =
  /(?:[\s,.!?-]+)?\b(?:lol+|ha(?:ha)+h?|lmao+|lmfao+|rofl|xd|hehe+)\s*[.!?]*\s*$/i;

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}️‍]+/gu;

/**
 * Strip a trailing filler token with high probability. Keeps the "lol" when
 * it's the entire bubble (that's a valid one-word reply) and when the bubble
 * already ends on strong punctuation like a question mark (reaction-as-retort).
 */
export function stripTrailingFiller(text: string, rng: Rng, probability = 0.85): string {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return text;
  // Don't touch bubbles that ARE a filler (e.g. whole-bubble "lol" as a one-word reply).
  if (/^(?:lol+|ha(?:ha)+h?|lmao+|lmfao+|hehe+|xd)[.!?\s]*$/i.test(trimmed)) return text;
  if (!TRAILING_FILLER_RE.test(trimmed)) return text;
  if (!rng.chance(probability)) return text;
  const stripped = trimmed.replace(TRAILING_FILLER_RE, "");
  return stripped.trimEnd();
}

/** Extract all emoji tokens from a bubble in order of appearance. */
function extractEmojis(text: string): string[] {
  const out: string[] = [];
  const matches = text.match(EMOJI_RE);
  if (!matches) return out;
  for (const m of matches) {
    // A single match might contain several consecutive emoji grapheme
    // clusters. Split naively per code point; good enough for cap logic.
    for (const codepoint of Array.from(m)) {
      if (/\p{Extended_Pictographic}/u.test(codepoint)) out.push(codepoint);
    }
  }
  return out;
}

/**
 * Keep at most one emoji in the bubble. When multiple are present the first
 * wins (usually the most intentional) and others are removed in-place.
 */
export function capEmojisPerBubble(text: string, max = 1): string {
  const emojis = extractEmojis(text);
  if (emojis.length <= max) return text;
  let kept = 0;
  return text.replace(EMOJI_RE, (match) => {
    let out = "";
    for (const ch of Array.from(match)) {
      if (/\p{Extended_Pictographic}/u.test(ch)) {
        if (kept < max) {
          out += ch;
          kept++;
        }
      } else {
        // zero-width joiners / variation selectors travel with preceding emoji
        if (out.length > 0) out += ch;
      }
    }
    return out;
  });
}

/**
 * Drop emoji from a bubble if the same emoji appeared in the previous bubble
 * of this turn OR if `recentEmojis` (from past turns) contains it. Encourages
 * variety and prevents the "every message has 🖤" tic.
 */
export function dedupeEmojiAcrossBubbles(bubbles: string[], recentEmojis: string[] = []): string[] {
  const seen = new Set(recentEmojis);
  return bubbles.map((b) => {
    const emojis = extractEmojis(b);
    if (emojis.length === 0) return b;
    const first = emojis[0]!;
    if (seen.has(first)) {
      // strip all emojis from this bubble
      return b.replace(EMOJI_RE, "").replace(/\s+([.!?,])/g, "$1").replace(/\s+$/, "").replace(/\s{2,}/g, " ");
    }
    seen.add(first);
    return b;
  });
}

/**
 * When the model emits 3 bubbles and they're short enough to join, collapse
 * to 1–2 with the given probability. Defense in depth against the
 * "three-bubble reflex" even when the humanness layer says default-to-one.
 * The model's intent is preserved because we concatenate in order.
 */
export function maybeCollapseBubbles(
  bubbles: string[],
  rng: Rng,
  opts: { probability?: number; maxCollapsedWords?: number } = {},
): string[] {
  const probability = opts.probability ?? 0.55;
  const maxWords = opts.maxCollapsedWords ?? 28;
  if (bubbles.length < 3) return bubbles;
  const total = bubbles.reduce((acc, b) => acc + b.split(/\s+/).filter(Boolean).length, 0);
  if (total > maxWords) return bubbles;
  if (!rng.chance(probability)) return bubbles;

  // Collapse to either 1 or 2 bubbles. 2 is more natural for longer content;
  // 1 for shorter.
  if (total <= 14 && rng.chance(0.6)) {
    return [joinBubbles(bubbles)];
  }
  // Two-bubble collapse: first bubble + remainder merged.
  const head = bubbles[0]!;
  const tail = joinBubbles(bubbles.slice(1));
  return [head, tail];
}

function joinBubbles(bubbles: string[]): string {
  // Join with a space; keep internal punctuation intact. Avoid double punctuation.
  return bubbles
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .join(" ")
    .replace(/\s+([.!?,])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface CleanupInput {
  bubbles: string[];
  rng: Rng;
  /** Emojis from the last N outbound bubbles, used to suppress repeats. */
  recentEmojis?: string[];
  /** Whether this turn should have any emoji at all. Supplied by style/rhythm. */
  allowEmoji?: boolean;
  /**
   * How many of the most-recent outbound bubbles started with a lazy "mmm" /
   * "aw" opener. When >= 1 we strip that opener from this turn's bubble(s)
   * to prevent the bot from defaulting to the same sound every reply. The
   * actual cap is enforced via prompt-level guidance; this is the safety net.
   */
  recentLazyOpenerCount?: number;
}

/**
 * Strip a lazy "mmm" / "aw" / "damn" opener from the start of a bubble. The
 * model defaults to these as filler lead-ins on roughly half of replies and
 * the persona prompt's instruction to "vary openers" doesn't reliably stick.
 * This is the post-process safety net.
 *
 * Matches the filler optionally preceded by a laugh-token ("haha damn babe"
 * → strips "haha damn"). Preserves the rest of the message.
 *
 * "mmm thanks for noticin babe"   → "thanks for noticin babe"
 * "Aw babe i havent shot that"    → "babe i havent shot that"
 * "Damn babe, that has me hot"    → "babe, that has me hot"
 * "Haha damn babe, already makin" → "babe, already makin"
 */
const LAZY_OPENER_STRIP_RE =
  /^[ \t]*(?:(?:lo+l+|ha+ha+h?|lma+o+|ahaha+)\s+)?(?:m+m+|mmm+m*|a+w+|aww+w*|ohh*|oof+|d+a+m+n+)[\s,!.\-—–]+(?=\S)/i;
export function stripLazyOpener(text: string): string {
  if (!LAZY_OPENER_STRIP_RE.test(text)) return text;
  let out = text.replace(LAZY_OPENER_STRIP_RE, "");
  // Preserve sentence-start: capitalize the first alpha if the rest of the
  // bubble is sentence-cased (rare for this persona, but safe).
  if (out.length > 0 && /^[a-z]/.test(out) && /[A-Z]/.test(text)) {
    out = out[0]!.toUpperCase() + out.slice(1);
  }
  return out;
}

/**
 * One-shot cleanup invoked from the humanizer pipeline. Order matters:
 *   1. collapse (change shape first so downstream ops act on the final count)
 *   2. stripTrailingFiller (before emoji dedup — a stripped "lol 🖤" leaves 🖤)
 *   3. capEmojisPerBubble
 *   4. dedupeEmojiAcrossBubbles (within turn + vs recent history)
 *   5. if !allowEmoji → strip all emoji
 */
export function applyCleanup(input: CleanupInput): string[] {
  const { rng, recentEmojis = [], allowEmoji = true, recentLazyOpenerCount = 0 } = input;

  let bubbles = maybeCollapseBubbles(input.bubbles, rng);
  bubbles = bubbles.map((b) => stripTrailingFiller(b, rng));
  bubbles = maybeStripTrailingQuestion(bubbles, rng);
  // Strip "Mmm" / "Aw" / "Ohh" / "Oof" lazy openers from the FIRST bubble.
  // Always-strip — the persona prompt explicitly forbids them as a default
  // and the LLM keeps producing them anyway. If the model REALLY wants
  // those sounds, it can place them mid-message (regex only matches at
  // start). Previous "only strip if recent count >= 1" gate let first
  // occurrences slip through — observed in production every conversation
  // started with "Mmm thanks babe" / "Aw babe".
  if (bubbles.length > 0 && bubbles[0]) {
    bubbles[0] = stripLazyOpener(bubbles[0]);
  }
  // Strip banned friend-zone emoji + ASCII emoticons + punctuation spacing
  // BEFORE the count-cap, so a banned emoji doesn't consume the "1 emoji"
  // budget and crowd out a valid one.
  bubbles = bubbles.map((b) => stripBannedArtifacts(b));
  bubbles = bubbles.map((b) => capEmojisPerBubble(b, 2));
  bubbles = dedupeEmojiAcrossBubbles(bubbles, recentEmojis);

  if (!allowEmoji) {
    bubbles = bubbles.map((b) =>
      b.replace(EMOJI_RE, "").replace(/\s+([.!?,])/g, "$1").replace(/\s{2,}/g, " ").trim(),
    );
  }

  return bubbles.map((b) => b.trim()).filter((b) => b.length > 0);
}

/**
 * Strip a trailing question when the reply recently ended in a question — the
 * model's biggest tic is "ping-pong interview mode". Looks at the LAST short
 * sentence of the LAST bubble; if it's a question AND the rng rolls under the
 * strip probability, drop it. Converts "that's cool, whats your favorite?" to
 * "that's cool". Statements beat questions as defaults.
 */
const TRAILING_QUESTION_RE = /(?:^|[.!?])\s*([^.!?]+\?)\s*$/;

export function maybeStripTrailingQuestion(
  bubbles: string[],
  rng: Rng,
  opts: { probability?: number; minStatementWords?: number } = {},
): string[] {
  if (bubbles.length === 0) return bubbles;
  const probability = opts.probability ?? 0.6;
  const minStatementWords = opts.minStatementWords ?? 3;
  if (!rng.chance(probability)) return bubbles;

  const out = [...bubbles];
  const lastIdx = out.length - 1;
  const last = out[lastIdx]!;
  const match = TRAILING_QUESTION_RE.exec(last);
  if (!match) return bubbles;

  const withoutQuestion = last.slice(0, last.length - match[1]!.length).trimEnd().replace(/[,.]$/, "").trim();
  // Only strip if what's left is a real statement, not just filler ("lol?", "hmm?")
  const remainingWords = withoutQuestion.split(/\s+/).filter(Boolean).length;
  if (remainingWords < minStatementWords) return bubbles;

  out[lastIdx] = withoutQuestion;
  return out.filter((b) => b.trim().length > 0);
}

// Friend-zone / corporate emoji that break the flirty register. Hermes
// emits these despite the prompt ban (observed 👍 🙄 inside a sext, 2026-06-03).
// Prompt-level bans don't stick on Hermes, so strip them deterministically.
const BANNED_EMOJI = new Set(["👍", "👌", "🙏", "💯", "🙌", "😂", "🙄", "🤝", "✌️", "✌"]);
const ASCII_EMOTICON_RE = /\s*<\/?3|\s*:\)|\s*:3|\s*:-\)/g;

/**
 * Strip banned friend-zone/corporate emoji + ASCII emoticons + normalize
 * stray spaces before punctuation ("word ," → "word,"). Durable safety net
 * because Hermes disregards the prompt-level palette ban.
 */
// Lone (unpaired) UTF-16 surrogate halves. Hermes emoji occasionally get
// split at a JSON-string or max-token boundary, leaving an orphan low/high
// surrogate that renders as "�" in the fan's app. Strip them. (Khlo cert
// 2026-06-03: 4/12 replies shipped a lone \uDC8F.)
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Markdown emphasis asterisks — fans see raw "*word*"; Hermes emits them.
const MD_ASTERISK_RE = /\*+([^*\n]+?)\*+/g;

export function stripBannedArtifacts(text: string): string {
  let out = text;
  // Strip orphaned emoji surrogate halves first (fan-visible "�" bug).
  out = out.replace(LONE_SURROGATE_RE, "");
  // Strip angle-bracket pseudo-tokens. Hermes sometimes TYPES the literal
  // text "<EMOJI_EYES>" / "<EMOJI_HEART>" / "<...>" as its idea of an emoji
  // placeholder — these reached real fans (skeptic conv-test 2026-06-03).
  // Drop any <ALL_CAPS_OR_WORD> token that isn't real prose.
  out = out.replace(/<\/?[A-Za-z][A-Za-z0-9 _-]{0,30}>/g, "");
  // Strip leaked internal scaffolding labels (spender conv-test 2026-06-04:
  // "Script 1 · rung 1", "Tease:", "Preview:" appeared in sent captions —
  // these are the asset's internal title/step labels the model echoed).
  out = out.replace(/\bscript\s*\d+\s*[·•\-–]\s*rung\s*\d+\b/gi, "");
  out = out.replace(/\brung\s*\d+\b/gi, "");
  out = out.replace(/^\s*(?:tease|preview|caption|ppv|pitch|step\s*\d*)\s*:\s*/gi, "");
  // Strip trailing JSON-envelope residue that escaped the parser (e.g. a
  // caption ending in `"}` or `"]}` — GFE conv-test found one shipped to a
  // fan). A real flirty message never ends in a brace/bracket, so a trailing
  // run of quote+brace/bracket chars is always junk.
  out = out.replace(/\s*["'`]*[}\]]+["'`]*\s*$/g, "");
  // Unwrap markdown emphasis ("*soft one*" → "soft one"), then drop strays.
  out = out.replace(MD_ASTERISK_RE, "$1").replace(/\*/g, "");
  // Remove banned emoji code points.
  out = out.replace(EMOJI_RE, (match) => {
    let kept = "";
    for (const ch of Array.from(match)) {
      if (/\p{Extended_Pictographic}/u.test(ch)) {
        if (!BANNED_EMOJI.has(ch)) kept += ch;
      } else if (kept.length > 0) {
        kept += ch; // keep ZWJ/variation selectors with a surviving emoji
      }
    }
    return kept;
  });
  // ASCII emoticons.
  out = out.replace(ASCII_EMOTICON_RE, "");
  // Stray space before punctuation + collapse doubles.
  out = out.replace(/\s+([.,!?])/g, "$1").replace(/\s{2,}/g, " ");
  return out.trim();
}

/** Utility for other modules: pull the first emoji out of each bubble for the emoji-history log. */
export function emojisOf(bubbles: string[]): string[] {
  const out: string[] = [];
  for (const b of bubbles) {
    const e = extractEmojis(b);
    if (e.length > 0) out.push(e[0]!);
  }
  return out;
}
