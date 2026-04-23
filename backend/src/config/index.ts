import dotenv from "dotenv";
dotenv.config();                            // .env (committed defaults)
dotenv.config({ path: ".env.local", override: true }); // .env.local (git-ignored secrets)
import { z } from "zod";

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
