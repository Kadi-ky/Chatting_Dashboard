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
        `2. **Body** — 1-2 short sentences in your character voice. Reference what's in the asset description in YOUR voice (don't recite the description verbatim). Add a sense of personal selection ("only sending to a few of u", "picked u for this", "thinkin of fans like u").`,
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
