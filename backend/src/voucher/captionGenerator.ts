import { logger } from "../observability/logger.js";
import { routeLlmCall } from "../llm/router.js";
import type { LlmMessage } from "../llm/types.js";
import { loadIdentityLayer } from "../prompt/layers/identity.js";
import { HUMANNESS_LAYER, HUMANNESS_VERSION } from "../prompt/layers/humanness.js";
import { CONTRACT_LAYER, CONTRACT_VERSION } from "../prompt/layers/contract.js";

/**
 * Voucher caption generator.
 *
 * Generates the caption that ships with a priced PPV in the voucher mass
 * send. Style modeled on operator's reference (2026-05-14):
 *
 *   50% OFF VOUCHER
 *   once you open it, you'll have 2 hours to choose what you want to see
 *   (nudity, BG, solo play, etc)… and whatever you pick is 50% off!!!
 *   only a limited few are getting this, so don't wait too long…
 *
 * Notes on faithfulness to that exact format:
 *   - We DON'T literally promise a "2h choice window" because we don't have
 *     redemption infrastructure (yet — see project_voucher_mass_send memory).
 *     This send IS the priced PPV, not a redemption code.
 *   - We DO carry the visual structure: bold-feel headline + scarcity beat
 *     + urgency window framing.
 *   - The asset description anchors what's IN the clip — caption hints
 *     without spoiling.
 *
 * Voice still loads per-account (Khlo vs Ari persona), so the voucher
 * pitches in the creator's character — not a generic broadcast voice.
 */

const RECENT_VOUCHER_RING_MAX = 12;
const RECENT_VOUCHER_TTL_SEC = 30 * 24 * 3600;

/**
 * Normalize a voucher caption's BODY (skip the unicode-bold header line)
 * for near-duplicate detection. Operator audit 2026-05-24 found 4 vouchers
 * in one tick all reading "picked u cuz [verb-ing] just for/thinkin of
 * fans like u" — same body across different headers, all sent same minute.
 * Cause: per-account dedup ring fed to prompt but no hard-reject, and
 * grok-4 locks on "picked u cuz / fans like u" template.
 */
function normalizeVoucherBody(caption: string): string {
  // Drop the first line (header is unicode-bold and varies more than body).
  const lines = caption.split(/\n/);
  const body = lines.length > 1 ? lines.slice(1).join(" ") : caption;
  return body
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function generateVoucherCaption(args: {
  accountId: string;
  subscriberId: string;
  fanExternalId: string;
  fanDisplayName: string | null;
  scriptName: string | null;
  assetDescription: string | null;
  voucherPriceCents: number;
  impliedRegularPriceCents: number;
  recentTexts: string[];
}): Promise<string | null> {
  try {
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

    const messages: LlmMessage[] = [{ role: "system", content: prefix }];

    const voucherDollars = (args.voucherPriceCents / 100).toFixed(0);
    const impliedDollars = (args.impliedRegularPriceCents / 100).toFixed(0);

    messages.push({
      role: "system",
      content: [
        `# Task — VOUCHER MASS SEND`,
        ``,
        `You're sending an UNPROMPTED priced PPV to a sub who's been quiet. The frame is a "limited drop / 50% off voucher" — a tripwire designed to convert silent fans.`,
        ``,
        `## Voucher details (for caption framing only — DO NOT mention the dollar amount in your caption, the price renders automatically in the PPV bubble):`,
        `- Voucher price: $${voucherDollars}`,
        `- Implied regular price: $${impliedDollars} (this is the "50% off" math the caption hints at)`,
        `- Asset description: ${args.assetDescription || "(no description)"}`,
        args.scriptName ? `- Script name: ${args.scriptName}` : ``,
        ``,
        `## CAPTION STRUCTURE (mandatory):`,
        `1. **Header line** — short, bold-feel, signals the deal. Examples: "50% OFF DROP", "LIMITED VOUCHER", "TONIGHT ONLY", "MY FAVES GET THIS". Use bold-looking ALL CAPS or unicode bold (𝐎𝐅𝐅𝐄𝐑). ONE line, 3-6 words.`,
        `2. **Body** — 1-2 short sentences in your character voice. Reference what's in the asset description in YOUR voice (don't recite the description verbatim). Add a sense of personal selection IN YOUR OWN WORDS. CRITICAL: do NOT use the phrases "picked u", "picked u cuz", "picked u for this", "for fans like u", or "thinkin of fans like u" — these are overused template phrases the model keeps emitting and they read as bot-generated to fans. Find a fresh way to signal scarcity + personal pick each time (e.g. "wasn't gonna share this one but u crossed my mind", "savin this one for the few i wanna spoil", "only droppin this for the ones who actually back me").`,
        `3. **Urgency/scarcity beat** — short, time-limited. "few hours only", "before midnight", "only a handful gettin this".`,
        ``,
        `## CRITICAL RULES`,
        `- Total caption: 35-55 words across the 3 sections.`,
        `- The HEADER LINE should literally be a separate first line (use \\n line break).`,
        `- DO NOT mention any dollar amount in the caption text — the PPV bubble shows it automatically.`,
        `- DO NOT explicitly say "voucher" or "code" or "redemption" — this is the actual PPV, just framed urgent.`,
        `- The fan has been quiet — don't reference past convo, this is a fresh broadcast.`,
        `- Stay in CHARACTER (persona above tells you who you are — Khlo = playful brat / Ari = sex demon, etc).`,
        `- Don't echo the asset description literally — paraphrase in your voice.`,
        `- One emoji max in the body (from humanness palette).`,
        ``,
        ...(args.recentTexts.length > 0
          ? [
              `RECENT VOUCHER SENDS (last ~12 across all fans on this account) — DO NOT repeat the header, body shape, or urgency phrasing of these. Each fan should feel they got a unique drop, not a templated blast:`,
              ...args.recentTexts.slice(0, 10).map((t, i) => `  ${i + 1}. ${t}`),
              ``,
            ]
          : []),
        ...(args.fanDisplayName
          ? [`Fan's display name: "${args.fanDisplayName}". Optional: address by name if it's a real first name (not username with digits).`, ``]
          : []),
        `OUTPUT FORMAT — STRICT JSON. Return a single JSON object exactly like:`,
        `  {"caption": "the full caption with newline between header and body"}`,
        `Rules: no markdown fences, no prose around the JSON, no placeholder values.`,
      ].filter(Boolean).join("\n"),
    });

    const result = await routeLlmCall({
      task: "CHAT_GENERATE",
      messages,
      maxTokens: 350,
      temperature: 0.95,
      responseFormat: "json_object",
      meta: {
        subscriberId: args.subscriberId,
        accountId: args.accountId,
        kind: "voucher_send",
      },
    });

    const text = extractCaption(result.content);
    if (!text || text.length < 15 || text.length > 400) {
      logger.warn(
        { rawLength: result.content.length, extractedLength: text.length },
        "voucher caption rejected — too short/long or unparseable",
      );
      return null;
    }
    // Hard near-duplicate reject on BODY (ignoring header). Stops the
    // "picked u cuz [body verb] fans like u" template-clone the LLM
    // keeps emitting across fans. Returns null → caller skips voucher
    // for this fan this tick (lock rolls back; will retry next tick
    // when ring has new content).
    const norm = normalizeVoucherBody(text);
    if (norm.length >= 8 && args.recentTexts.some((t) => normalizeVoucherBody(t) === norm)) {
      logger.warn(
        { accountId: args.accountId, caption: text },
        "voucher caption rejected — near-duplicate body of recent send",
      );
      return null;
    }
    // Opener lock-in reject (agent audit 2026-05-25): exact-body dedup
    // missed the "picked u cuz [X] fans like u" template family because
    // the verb in [X] varies across sends. Catch the template by checking
    // the first 4 normalized words — if 2+ of the recent ~12 sends start
    // with the same opener, the LLM is locked. Return null and let
    // caller retry with a thinner ring.
    const opener = norm.split(" ").slice(0, 4).join(" ");
    if (opener.length >= 6) {
      const sameOpenerCount = args.recentTexts.filter(
        (t) => normalizeVoucherBody(t).startsWith(opener),
      ).length;
      if (sameOpenerCount >= 2) {
        logger.warn(
          { accountId: args.accountId, caption: text, opener, sameOpenerCount },
          "voucher caption rejected — opener template repeats across recent sends",
        );
        return null;
      }
    }
    return text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "voucher caption generation failed",
    );
    return null;
  }
}

function extractCaption(raw: string): string {
  const trimmed = raw.trim();
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.caption === "string") return obj.caption.trim();
  } catch {
    // fall through
  }
  // Try extracting from a stray object
  const m = /\{[\s\S]*?"caption"\s*:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?\}/.exec(trimmed);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1] ?? "";
    }
  }
  return trimmed;
}

export { RECENT_VOUCHER_RING_MAX, RECENT_VOUCHER_TTL_SEC };
