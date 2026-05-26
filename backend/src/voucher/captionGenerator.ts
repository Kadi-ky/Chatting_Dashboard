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

// ─── Sam-Taylor-style mass-message patterns ──────────────────────────────
// Operator export 2026-05-26: analyzed Sam Taylor's mass-message export +
// confirmed the patterns that move money in the OF mass-send game. Captions
// are now structured to match that playbook (day-of-week themes, anchored
// price slashes, reluctance theater, photo-number teases, N-for-$N gimmicks,
// itemized manifests). Voice still loads per-account persona — only the
// mass-message STRUCTURE is borrowed, not the conversational tone.

const DAY_THEMES: Record<number, { label: string; hooks: string[] }> = {
  0: { label: "SUNDAY",    hooks: ["SUNDAY 🦋 DAY SPECIAL", "lazy sunday treat", "sunday spoil"] },
  1: { label: "MONDAY",    hooks: ["MONDAY BLUES CURED", "monday again??", "monday pick-me-up"] },
  2: { label: "TUESDAY",   hooks: ["TITTY TUESDAY", "TUESDAY DROP", "cherry tuesday"] },
  3: { label: "WEDNESDAY", hooks: ["HUMP DAY SPOIL", "midweek 🦋", "wednesday treat"] },
  4: { label: "THURSDAY",  hooks: ["THIRSTY THURSDAY", "THURSDAY TEASE", "almost-friday gift"] },
  5: { label: "FRIDAY",    hooks: ["FRIDAY BIG TREAT", "MADE-IT-TO-FRIDAY drop", "weekend opener"] },
  6: { label: "SATURDAY",  hooks: ["WEEKEND CHAOS", "saturday FLASH SALE", "weekend special"] },
};

// Reluctance theater bank — sampled per send to vary across the batch and
// create "stealing a deal" psychology. Sam Taylor uses these constantly.
const RELUCTANCE_BANK = [
  "my hands were literally shaking",
  "these were supposed to stay private",
  "i never do stuff like this",
  "in that screw-it mood",
  "wasn't supposed to send this",
  "i officially lost my mind",
  "really shouldn't be sending this so cheap",
  "this was supposed to be VIP-only",
  "took my bra off for this",
  "before i remember i wasn't supposed to send this",
];

function pickReluctance(seed: string): string {
  // Stable per-send variety: hash the seed (fan id + day) to an index so
  // the same fan doesn't get the same reluctance phrase twice in a row.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return RELUCTANCE_BANK[Math.abs(h) % RELUCTANCE_BANK.length]!;
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

    const voucherDollars = Math.round(args.voucherPriceCents / 100);
    const impliedDollars = Math.round(args.impliedRegularPriceCents / 100);
    const discountPct = impliedDollars > 0
      ? Math.round(((impliedDollars - voucherDollars) / impliedDollars) * 100)
      : 0;
    const dayInfo = DAY_THEMES[new Date().getUTCDay()]!;
    const reluctance = pickReluctance(`${args.fanExternalId}:${dayInfo.label}`);

    // Tier-aware framing — cheap voucher gets N-for-$N gimmick, premium
    // gets itemized manifest, mid stays simple. Mirrors what Sam Taylor
    // does naturally based on price tier.
    const tier: "cheap" | "mid" | "premium" =
      voucherDollars <= 20 ? "cheap"
      : voucherDollars >= 69 ? "premium"
      : "mid";

    messages.push({
      role: "system",
      content: [
        `# Task — VOUCHER MASS SEND (day-themed, Sam-Taylor style)`,
        ``,
        `You're sending an UNPROMPTED priced PPV to a sub who's been quiet. This is a MASS MESSAGE — same caption structure goes to many fans, fan does NOT expect a conversational reply. Structure has to do the selling.`,
        ``,
        `## Today's context`,
        `- Day-of-week: ${dayInfo.label}`,
        `- Day theme options (PICK ONE for the header, or invent a fresh ${dayInfo.label}-specific hook): ${dayInfo.hooks.map((h) => `"${h}"`).join(", ")}`,
        `- Voucher price: $${voucherDollars}`,
        `- Implied regular price: $${impliedDollars}`,
        `- Discount: ${discountPct}% off`,
        `- Tier: ${tier} (drives header style + body length below)`,
        `- Asset description: ${args.assetDescription || "(no description)"}`,
        args.scriptName ? `- Script name: ${args.scriptName}` : ``,
        ``,
        `## REQUIRED CAPTION STRUCTURE (4 parts, in order, separated by \\n line breaks)`,
        ``,
        `1. **HEADER LINE** — bold-feel, day-themed, includes price anchor when there's a real discount.`,
        `   - For ${tier === "cheap" ? "CHEAP tier ($≤20)" : tier === "premium" ? "PREMIUM tier ($≥69)" : "MID tier"}:`,
        tier === "cheap"
          ? `     Use a "N-for-$N" or sharp anchor format. Examples: "${dayInfo.hooks[0]} 🦋 ${voucherDollars} PICS FOR $${voucherDollars}", "${dayInfo.label} SPECIAL — $${voucherDollars}", "BARE 🍒 FOR $${voucherDollars}". Bold ALL CAPS or unicode bold (𝐎𝐅𝐅𝐄𝐑).`
          : tier === "premium"
            ? `     Use a clear price-slash anchor. Examples: "${dayInfo.hooks[0]} 🦋 $${impliedDollars} → $${voucherDollars}", "WEEKEND FLASH SALE $${impliedDollars} → $${voucherDollars}", "${discountPct}% OFF ${dayInfo.label}". Bold ALL CAPS.`
            : `     Use a day-themed hook. Examples: "${dayInfo.hooks[0]}", "${dayInfo.hooks[1] ?? dayInfo.hooks[0]} 🍒", "${dayInfo.label} TEASE — $${impliedDollars} → $${voucherDollars}". Bold ALL CAPS or unicode bold.`,
        `   - ONE line, 3-7 words plus optional emoji.`,
        ``,
        `2. **HOOK BODY** — 1-2 sentences in YOUR character voice. Reference what's in the asset description in YOUR words (don't recite verbatim). Set the scene with sensory detail.`,
        `   FORBIDDEN PHRASES (overused template clones): "picked u", "picked u cuz", "for fans like u", "thinkin of fans like u", "just for u tonight". Find a fresh way to set the scene each time.`,
        ``,
        `3. **RELUCTANCE THEATER** — exactly ONE reluctance phrase that creates a "stealing a deal" feeling. USE: "${reluctance}". (Or paraphrase the same VIBE — creator acting against her own interest, signals the deal is special.)`,
        ``,
        tier === "premium"
          ? `4. **ITEMIZED TEASE** (premium-only required) — 2-3 bullets with 🍒 / 🍑 / 🦋 prefix listing what's IN the bundle. Pull from the asset description. Each bullet should be a specific scene/angle/act (paraphrased, not invented). Format example:\n     "🍒 squeezing topless views\n     🍑 ass shaking in doggy\n     🦋 POV positions usually behind VIP"`
          : `4. **SPECIFIC PHOTO TEASE** — one short callout like "pic #5 will have you shaking", "the 7th angle is unreal", "wait til you see pic #3". Pick a number 2-9. Creates curiosity about ONE specific item.`,
        ``,
        `## EMOJI CODE (Sam-Taylor style)`,
        `- 🍒 = tits / chest`,
        `- 🍑 = ass / booty`,
        `- 🦋 = "the deal" / "the drop" — use sparingly in headers`,
        `- 😳 / 🥵 / 🥹 = reaction emojis, max ONE per caption`,
        ``,
        `## CRITICAL RULES`,
        `- Total caption: ${tier === "premium" ? "60-110 words" : tier === "cheap" ? "25-45 words" : "35-65 words"}.`,
        `- HEADER on its own first line (use literal \\n).`,
        `- DO NOT mention any dollar amount IN THE BODY (only the header anchor shows $X → $Y). The PPV bubble renders the price itself.`,
        `- DO NOT explicitly say "voucher" / "code" / "redemption" — frame as the actual drop.`,
        `- Stay in CHARACTER (persona above — Khlo / Ari).`,
        `- Don't echo the asset description literally — paraphrase.`,
        `- The fan has been quiet — this is a fresh broadcast, no prior-convo references.`,
        ``,
        ...(args.recentTexts.length > 0
          ? [
              `RECENT VOUCHER SENDS (last ~12 across all fans on this account) — DO NOT repeat the header, body shape, reluctance phrase, or urgency phrasing of these. Each fan should feel they got a unique drop, not a templated blast:`,
              ...args.recentTexts.slice(0, 10).map((t, i) => `  ${i + 1}. ${t}`),
              ``,
            ]
          : []),
        ...(args.fanDisplayName
          ? [`Fan's display name: "${args.fanDisplayName}". Optional: address by name once if it's a real first name (not username with digits).`, ``]
          : []),
        `OUTPUT FORMAT — STRICT JSON. Return a single JSON object exactly like:`,
        `  {"caption": "the full caption with newlines between each of the 4 parts"}`,
        `Rules: no markdown fences, no prose around the JSON, no placeholder values.`,
      ].filter(Boolean).join("\n"),
    });

    const result = await routeLlmCall({
      task: "CHAT_GENERATE",
      messages,
      // Premium-tier captions with itemized manifest can hit ~700 chars
      // ≈ ~250-300 tokens. Header (~30) + body (~120) + reluctance (~30)
      // + manifest (~100) = ~280. Headroom for JSON overhead + emoji.
      maxTokens: 600,
      temperature: 0.95,
      responseFormat: "json_object",
      meta: {
        subscriberId: args.subscriberId,
        accountId: args.accountId,
        kind: "voucher_send",
      },
    });

    const text = extractCaption(result.content);
    // Widened upper bound 2026-05-26: premium tier captions with itemized
    // manifest can legitimately run 600-800 chars (Sam-Taylor-style). Lower
    // bound stays tight to reject one-word junk.
    if (!text || text.length < 15 || text.length > 800) {
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
