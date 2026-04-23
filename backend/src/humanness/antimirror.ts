/**
 * Anti-mirror detection + stripping. LLMs have a strong tendency to open a
 * reply by parroting the fan's words as a question ("automating chats? cute").
 * The humanness layer tells the model not to. This module enforces it when
 * the model ignores the rule.
 *
 *   1. deriveAntiMirrorDirective(inbound) — builds a per-turn forbidden list
 *      injected into the TASK layer (which sits last in the prompt and
 *      therefore carries the most recency weight).
 *   2. stripMirrorOpener(bubble, inbound) — post-processor that detects an
 *      echo-opener and strips it, leaving the rest of the reply intact.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "is", "are", "was", "were",
  "be", "am", "been", "being", "to", "of", "in", "on", "at", "for", "with",
  "by", "from", "as", "so", "that", "this", "these", "those", "it", "its",
  "i", "you", "u", "ur", "my", "your", "me", "we", "us", "our", "they", "them",
  "he", "she", "his", "her", "do", "does", "did", "doing", "have", "has", "had",
  "will", "would", "can", "could", "should", "may", "might", "just", "like",
  "lol", "haha", "lmao", "omg", "yeah", "yea", "yes", "no", "ok", "okay", "well",
  "some", "any", "what", "when", "where", "why", "how", "who", "all", "get",
  "got", "go", "going", "etc", "too", "also", "thing", "things", "stuff",
  "fr", "rn", "tbh", "btw", "idk", "ngl",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** Extract content (non-stopword, length >= 3) words and bigrams from the fan's text. */
export function contentKeywords(inbound: string): { words: string[]; bigrams: string[] } {
  const tokens = tokenize(inbound);
  const words = tokens.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    // a bigram is interesting if at least one of the two is a content word
    if ((a.length >= 3 && !STOPWORDS.has(a)) || (b.length >= 3 && !STOPWORDS.has(b))) {
      bigrams.push(`${a} ${b}`);
    }
  }
  return { words: unique(words).slice(0, 8), bigrams: unique(bigrams).slice(0, 6) };
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * Short per-turn instruction listing phrases the model must not echo in its
 * opener. Injected into the TASK layer — sits last in the prompt, where
 * recency bias gives it more weight than the cached humanness prefix.
 */
export function deriveAntiMirrorDirective(inbound: string): string | null {
  const { words, bigrams } = contentKeywords(inbound);
  if (words.length === 0 && bigrams.length === 0) return null;

  const examples: string[] = [];
  for (const b of bigrams.slice(0, 4)) examples.push(`"${b}"`);
  for (const w of words.slice(0, 6)) examples.push(`"${w}"`);

  return [
    `Anti-mirror (this turn specifically):`,
    `The fan just used these words/phrases: ${examples.join(", ")}.`,
    `Do NOT open your reply by repeating any of them back, especially not as a question.`,
    `Do not start with "${words[0] ?? "that"}?..." or any similar echo.`,
    `React to what they MEANT, not to the surface of their words. Go straight to the next beat of the conversation.`,
  ].join("\n");
}

const ECHO_OPENER_SPLIT_RE = /[?!.,]/;

/**
 * Detect and strip a mirror-opener from the first bubble. Rules:
 *
 *   - Take the first clause (text before the first ?, !, . or ,).
 *   - If that clause contains 2+ content tokens that also appear in the
 *     fan's last inbound, it's an echo — strip it and return the rest.
 *   - If stripping would leave nothing, return the original text (don't
 *     delete the whole bubble; better a weaker reply than no reply).
 */
export function stripMirrorOpener(bubble: string, inbound: string): string {
  if (!bubble) return bubble;
  const match = ECHO_OPENER_SPLIT_RE.exec(bubble);
  if (!match) return bubble;
  const splitAt = match.index;
  const opener = bubble.slice(0, splitAt);
  const rest = bubble.slice(splitAt + 1).trim();
  if (!rest) return bubble;

  const openerTokens = tokenize(opener).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (openerTokens.length === 0) return bubble;

  const fanTokens = new Set(tokenize(inbound).filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
  let overlap = 0;
  for (const t of openerTokens) if (fanTokens.has(t)) overlap++;

  // Require at least 2 overlapping content tokens OR 1 if the opener is short
  // and dominated by that overlap (e.g. single-word echo like "chatbots?").
  const threshold = openerTokens.length <= 2 ? 1 : 2;
  if (overlap < threshold) return bubble;

  // Capitalise the start of the remainder so it reads like a clean reply.
  const capped = rest[0]!.toLowerCase() + rest.slice(1);
  return capped;
}

/**
 * Apply stripMirrorOpener to the FIRST bubble only — the opener is the tell.
 * Returns the bubble list unchanged if nothing was stripped.
 */
export function scrubMirrorOpeners(bubbles: string[], inbound: string): string[] {
  if (bubbles.length === 0) return bubbles;
  const first = bubbles[0]!;
  const scrubbed = stripMirrorOpener(first, inbound);
  if (scrubbed === first) return bubbles;
  const out = [...bubbles];
  out[0] = scrubbed;
  return out.filter((b) => b.trim().length > 0);
}
