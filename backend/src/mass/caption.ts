import { logger } from "../observability/logger.js";
import { sharedRedis } from "../queue/redis.js";
import { loadIdentityLayer } from "../prompt/layers/identity.js";
import { HUMANNESS_LAYER, HUMANNESS_VERSION } from "../prompt/layers/humanness.js";
import { CONTRACT_LAYER, CONTRACT_VERSION } from "../prompt/layers/contract.js";
import { routeLlmCall } from "../llm/router.js";
import type { LlmMessage } from "../llm/types.js";

/**
 * Mass-message caption generator.
 *
 * Replaces the static `mass_captions_onlyfans` rotation that n8n was
 * cycling through every hour. Each call generates a fresh caption in the
 * v1.8 pick-me / flirty / eager voice, with grok-4.1 reasoning picking the
 * angle (mood / tease / soft want / chaotic / scarcity / question-bait).
 *
 * Dedup: per-account Redis ring of the last MAX_RECENT captions. The
 * generator is told "don't repeat themes/phrasing from these" so successive
 * sends actually feel different — fans can't pattern-match the way they did
 * with the static pool.
 */

const REDIS_KEY = (accountId: string): string => `peach:mass-captions:${accountId}`;
const MAX_RECENT = 20;
const RECENT_TTL_SECONDS = 7 * 24 * 3600; // 7 days

export type MassCaptionVibe =
  | "mood"
  | "tease"
  | "soft"
  | "chaotic"
  | "scarcity"
  | "question"
  | "horny"
  | "playful"
  | "sweet";

const VIBE_GUIDANCE: Record<MassCaptionVibe, string> = {
  mood: "MOOD broadcast — share what energy you're in right now ('kinda bored, anyone wanna keep me company', 'in my feels tonight').",
  tease: "PHYSICAL tease — hint at what you're wearing/doing without being explicit ('just out the shower n my towel barely holdin on', 'in bed in nothin but a tshirt').",
  soft: "SOFT want — vulnerable, a little needy, dms-as-comfort ('rough day, my dms r my happy place tbh', 'need someone sweet to me tonight').",
  chaotic: "CHAOTIC energy — playful trouble vibe ('stop me from doin somethin reckless tonight', 'one wine in n im dangerous').",
  scarcity: "SCARCITY — exclusive opportunity for whoever responds first ('got somethin in mind for whoever messages me first', 'first one to dm me gets a treat').",
  question: "QUESTION-BAIT — open-ended ask that invites a reply ('whats got y'all up rn', 'what would u rather, lazy night or wild one').",
  horny: "HORNY — direct heat, full graphic-leaning register ('im worked up n need someone to keep up tonight', 'in bed, hand busy, who's awake').",
  playful: "PLAYFUL — silly flirt, joke, light bit ('lookin for a partner in crime tonight, applications open', 'who's gonna entertain me i refuse to sleep').",
  sweet: "SWEET — warm girlfriend energy, no overt sex ('thinkin bout my favorites tonight 🖤', 'hope y'all had a soft day').",
};

const ALL_VIBES = Object.keys(VIBE_GUIDANCE) as MassCaptionVibe[];

export interface GenerateMassCaptionArgs {
  accountId: string;
  /** Optional vibe override; otherwise the model picks from the rotation. */
  vibe?: MassCaptionVibe | null;
  /** Optional time-of-day hint surfaced to the model for tone shaping. */
  hourOfDay?: number;
}

export interface MassCaptionResult {
  caption: string;
  vibe: MassCaptionVibe | null;
  model: string;
  generatedAt: string;
}

export async function generateMassCaption(args: GenerateMassCaptionArgs): Promise<MassCaptionResult> {
  const recent = await loadRecentCaptions(args.accountId);
  const vibe = args.vibe ?? null;

  const identity = loadIdentityLayer(args.accountId);

  const prefix = [
    `# Identity`,
    identity,
    ``,
    `# Contract (v${CONTRACT_VERSION})`,
    CONTRACT_LAYER,
    ``,
    `# Humanness (v${HUMANNESS_VERSION})`,
    HUMANNESS_LAYER,
  ].join("\n");

  const taskParts: string[] = [
    `# Task — mass message caption (broadcast)`,
    ``,
    `You are about to send an UNPROMPTED mass DM to many fans simultaneously. Different fans, no shared conversation, no specific context. The system will attach an image automatically — your only output is the CAPTION text.`,
    ``,
    `HARD CONSTRAINTS:`,
    `- ONE bubble, 12-25 words, lowercase fragments mixed with normal phrasing`,
    `- Cannot reference a specific conversation, name, kink, or fan-specific detail`,
    `- Use broadcast-safe pronouns: "u", "y'all", "babes", "whoever" — not addressed to a specific person`,
    `- Match the v1.8 pick-me / flirty / eager voice (humanness layer above)`,
    `- No pricing, no PPV pitch, no "unlock"`,
    `- No "please", no begging`,
    `- No #hashtags, no @mentions, no urls`,
    `- Optional 1 emoji (max), rotated — never same emoji as the most recent send`,
    ``,
    `ANGLE — pick ONE per call, vary across calls so successive hours feel different:`,
    ...ALL_VIBES.map((v) => `- ${v.toUpperCase()}: ${VIBE_GUIDANCE[v]}`),
    ``,
  ];

  if (vibe) {
    taskParts.push(`VIBE LOCK (operator override): use the **${vibe.toUpperCase()}** angle for this call.`, ``);
  }

  if (typeof args.hourOfDay === "number") {
    const tod = describeTimeOfDay(args.hourOfDay);
    taskParts.push(`TIME OF DAY: ${tod}. Tone-shape accordingly (late-night = hornier/chaotic ok; morning = sweeter; afternoon = playful/mood).`, ``);
  }

  if (recent.length > 0) {
    taskParts.push(
      `RECENT SENDS — DO NOT repeat the angle, theme, opening word, or phrasing of any of these:`,
      ...recent.slice(0, 10).map((r, i) => `  ${i + 1}. ${r}`),
      ``,
    );
  }

  taskParts.push(
    `OUTPUT FORMAT (STRICT — required because the parser only extracts what's between the tags):`,
    `Wrap your final caption in <caption> tags, exactly like this example shape:`,
    `  <caption>in bed bored as hell, who's keepin me company tonight 😈</caption>`,
    ``,
    `You MAY think out loud or weigh angles before the opening tag — ONLY the text inside <caption>...</caption> is used. Do NOT include the example sentence verbatim. Generate a fresh one.`,
  );

  const messages: LlmMessage[] = [
    { role: "system", content: prefix },
    { role: "system", content: taskParts.join("\n") },
  ];

  const result = await routeLlmCall({
    task: "NUDGE_GENERATE",
    messages,
    // Reasoning models (grok-4.1-fast-reasoning) emit a chain-of-thought
    // before the final answer; 250 tokens (the NUDGE_GENERATE default) is
    // too tight and the answer never lands. Bump generously — the parser
    // extracts only the <caption> portion so token count doesn't bloat
    // the actual sent message.
    maxTokens: 1500,
    meta: {
      accountId: args.accountId,
      kind: "mass_caption",
      vibe: vibe ?? "auto",
    },
  });

  const caption = extractCaption(result.content);

  if (!caption || caption.length < 5 || caption.length > 280) {
    logger.warn(
      {
        accountId: args.accountId,
        rawLength: result.content.length,
        extractedLength: caption.length,
        rawPreview: result.content.slice(0, 200),
      },
      "mass caption extraction yielded unusable output",
    );
    throw new Error(
      `mass caption rejected: extracted=${caption.length} chars from raw=${result.content.length} chars`,
    );
  }

  await recordRecentCaption(args.accountId, caption);

  return {
    caption,
    vibe,
    model: result.model,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Pull the final caption out of the LLM response. Reasoning models emit
 * chain-of-thought BEFORE the answer; we asked for a <caption>...</caption>
 * wrapper, so prefer that. Falls back through a few heuristics for chat
 * models that ignore the tag instruction:
 *   1. <caption>...</caption>      — preferred, what we ask for
 *   2. text after "Caption:" line   — common reasoning model output
 *   3. last quoted string in body   — if model wrapped its answer in quotes
 *   4. last non-empty line          — final answer is usually the last line
 *   5. whole body trimmed           — chat models without prelude
 */
function extractCaption(raw: string): string {
  const trimmed = raw.trim();

  const tagMatch = trimmed.match(/<caption>([\s\S]*?)<\/caption>/i);
  if (tagMatch) return clean(tagMatch[1]!);

  const labelMatch = trimmed.match(/(?:^|\n)\s*(?:final\s+)?caption\s*[:\-]\s*(.+?)(?:\n\n|$)/i);
  if (labelMatch) return clean(labelMatch[1]!);

  const quotedMatches = [...trimmed.matchAll(/[""''"']([^""''"']{10,200})[""''"']/g)];
  if (quotedMatches.length > 0) {
    return clean(quotedMatches[quotedMatches.length - 1]![1]!);
  }

  const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 0) {
    const last = lines[lines.length - 1]!;
    if (last.length >= 5 && last.length <= 280) return clean(last);
  }

  return clean(trimmed);
}

function clean(s: string): string {
  return s
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadRecentCaptions(accountId: string): Promise<string[]> {
  try {
    return await sharedRedis().lrange(REDIS_KEY(accountId), 0, MAX_RECENT - 1);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, accountId },
      "failed to load recent mass captions; falling back to empty list",
    );
    return [];
  }
}

async function recordRecentCaption(accountId: string, caption: string): Promise<void> {
  try {
    const r = sharedRedis();
    await r.lpush(REDIS_KEY(accountId), caption);
    await r.ltrim(REDIS_KEY(accountId), 0, MAX_RECENT - 1);
    await r.expire(REDIS_KEY(accountId), RECENT_TTL_SECONDS);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, accountId },
      "failed to record mass caption to redis (caption was sent regardless)",
    );
  }
}

function describeTimeOfDay(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "late night";
}

export function isValidVibe(v: string): v is MassCaptionVibe {
  return (ALL_VIBES as string[]).includes(v);
}
