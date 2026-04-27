import dotenv from "dotenv";
dotenv.config();                            // .env (committed defaults)
dotenv.config({ path: ".env.local", override: true }); // .env.local (git-ignored secrets)
import { z } from "zod";

/**
 * Parse an env-var string as a boolean, with a sane default. DO NOT use Zod's
 * `z.coerce.boolean()` for this — it calls `Boolean(v)` which treats ANY
 * non-empty string as truthy, so the literal "false" comes back as `true`.
 * That bug cost us hours on 2026-04-27 hunting why Railway's SHADOW_MODE=false
 * wasn't taking effect.
 *
 * Recognised falsy strings: "false", "0", "no", "off" (case-insensitive).
 * Recognised truthy strings: "true", "1", "yes", "on" (case-insensitive).
 * Unset / empty / unrecognised → fallback to default.
 */
function stringBool(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return defaultValue;
      const lower = v.trim().toLowerCase();
      if (lower === "" ) return defaultValue;
      if (lower === "false" || lower === "0" || lower === "no" || lower === "off") return false;
      if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") return true;
      return defaultValue;
    });
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Dev convenience — used by the V3 Testing Ground admin endpoints only.
  // Production event flow (poller + webhook) routes per-account via the
  // v3.accounts.platform_account_id column, so this is not needed for
  // multi-creator deployments.
  ACCOUNT_ID: z.string().uuid(),

  DATABASE_URL: z.string().url(),

  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  GROK_API_KEY: z.string().min(1),
  GROK_API_BASE: z.string().url().default("https://api.x.ai/v1"),
  GROK_MODEL_GENERATOR: z.string().default("grok-4"),
  GROK_MODEL_CLASSIFIER: z.string().default("grok-4-1-fast-reasoning"),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_API_BASE: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_FALLBACK_MODEL: z
    .string()
    .default("nousresearch/nous-hermes-2-mixtral-8x7b-dpo"),
  OPENROUTER_CLASSIFIER_FALLBACK_MODEL: z.string().default("mistralai/mistral-small"),

  // "mock" — in-memory adapter (outbound sends captured, no real I/O).
  //          Use for local testing via the V3 Testing tab.
  // "http" — real platform HTTP adapter (requires PLATFORM_API_KEY + PLATFORM_API_BASE).
  PLATFORM_MODE: z.enum(["mock", "http"]).default("http"),
  // Empty strings from .env files are coerced to undefined so URL validation doesn't reject them.
  PLATFORM_API_KEY: z.string().transform(v => v || undefined).optional(),
  PLATFORM_API_BASE: z.string().transform(v => v || undefined).pipe(z.string().url().optional()),
  PLATFORM_WEBHOOK_SECRET: z.string().transform(v => v || undefined).optional(),
  // SHADOW MODE: receive real webhooks + run the full reply pipeline, but
  // NEVER actually call sendMessage / sendPPV against the platform. Instead
  // the adapter logs the would-send payload and returns a synthetic SendResult
  // (externalId prefixed with "shadow:"). Used for production-traffic A/B
  // testing without colliding with whatever bot is currently live for that
  // creator. Uses stringBool to parse "false" correctly (see comment below).
  SHADOW_MODE: stringBool(false),
  // Comma-separated list of CIDR blocks / single IPs that are trusted webhook
  // sources when no PLATFORM_WEBHOOK_SECRET is set. Used to defend the
  // unsigned `/webhooks/onlyfansapi` endpoint against forged requests.
  PLATFORM_WEBHOOK_TRUSTED_IPS: z.string().transform(v => v || undefined).optional(),
  // Comma-separated `acct_xxx` IDs the backend will actually process. When
  // set, ALL other webhook deliveries are dropped before any DB write — even
  // in shadow mode. Used to safely point our tunnel at OFAPI while another
  // production bot is live for accounts we're not testing. Leave blank to
  // accept every account (unsafe in prod alongside another live bot).
  PLATFORM_ACCOUNT_ALLOWLIST: z.string().transform(v => v || undefined).optional(),
  // CAREFUL: do NOT use z.coerce.boolean() with env strings. Zod's coerce
  // calls Boolean(v) which treats ANY non-empty string as truthy — so the
  // literal string "false" comes out as `true`, silently. This wrecked the
  // SHADOW_MODE flag on Railway 2026-04-27 (user set "false", code read true,
  // bot sat in shadow mode for hours while we hunted ghosts in OFAPI logs).
  // Use the explicit stringBool helper instead.
  POLLING_ENABLED: stringBool(false),
  PERSONA_ALWAYS_AWAKE: stringBool(true),
  // NUDGE_ENABLED: turns on the auto-nudge worker that re-engages idle fans
  // and follows up on pending PPVs. Default OFF — flip to true on Railway
  // when ready. Even when on, NUDGE_DRY_RUN=true makes it log what it WOULD
  // send without calling OFAPI.
  NUDGE_ENABLED: stringBool(false),
  NUDGE_DRY_RUN: stringBool(false),
  // Soft-resume ramp-up. When set to an ISO timestamp in the future, the
  // per-account token bucket runs at HALF its normal refill rate until that
  // time passes. Use this when un-pausing after a long 429 cooldown to
  // give OnlyFans's rate-limit flag time to clear without triggering a new
  // burst. Example: SEND_RAMP_UP_UNTIL=2026-04-27T13:00:00Z (60 min ramp).
  // Unset / empty / past time → normal rate.
  SEND_RAMP_UP_UNTIL: z.string().transform(v => v || undefined).optional(),
  // BUBBLE_COMBINE: collapse multiple text bubbles into a single OFAPI send
  // (joined by newlines). Pitch bubbles (PPVs) stay separate because their
  // wire format differs (price + media). When TRUE, a 3-bubble reply makes
  // 1 API call instead of 3, dramatically reducing the burst-fingerprint
  // OnlyFans's CF rate limiter sees. Default FALSE to preserve original
  // multi-bubble behavior; flip to TRUE on Railway when ready to A/B test.
  BUBBLE_COMBINE: stringBool(false),

  BURST_WINDOW_MS: z.coerce.number().int().positive().default(4000),
  CONVERSATION_LOCK_TTL_MS: z.coerce.number().int().positive().default(60_000),
  OUTBOUND_MIN_GAP_MS: z.coerce.number().int().nonnegative().default(20_000),
  WHALE_SPEND_30D_CENTS: z.coerce.number().int().nonnegative().default(50_000),
  PPV_COOLDOWN_DAYS: z.coerce.number().int().positive().default(14),

  ADMIN_PORT: z.coerce.number().int().positive().default(8787),
  ADMIN_TOKEN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// When running the real HTTP adapter, the two platform credentials become required.
if (parsed.data.PLATFORM_MODE === "http") {
  if (!parsed.data.PLATFORM_API_KEY || !parsed.data.PLATFORM_API_BASE) {
    console.error("PLATFORM_MODE=http requires PLATFORM_API_KEY and PLATFORM_API_BASE");
    process.exit(1);
  }
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
