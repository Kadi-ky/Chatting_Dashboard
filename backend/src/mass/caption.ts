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
    `OUTPUT: just the caption text. No JSON, no quotes, no preamble like "Here's a caption:" or "Sure!".`,
  );

  const messages: LlmMessage[] = [
    { role: "system", content: prefix },
    { role: "system", content: taskParts.join("\n") },
  ];

  const result = await routeLlmCall({
    task: "NUDGE_GENERATE",
    messages,
    meta: {
      accountId: args.accountId,
      kind: "mass_caption",
      vibe: vibe ?? "auto",
    },
  });

  const caption = result.content
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ");

  if (!caption || caption.length < 5 || caption.length > 280) {
    throw new Error(`mass caption rejected: length=${caption.length}`);
  }

  await recordRecentCaption(args.accountId, caption);

  return {
    caption,
    vibe,
    model: result.model,
    generatedAt: new Date().toISOString(),
  };
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
