import { Redis, type RedisOptions } from "ioredis";
import { env } from "../config/index.js";

function baseOptions(): RedisOptions {
  const opts: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  };
  // Upstash (and any rediss:// endpoint) requires TLS. ioredis enables TLS
  // automatically for rediss:// URLs but needs rejectUnauthorized: false for
  // some managed-Redis providers.
  if (env.REDIS_URL.startsWith("rediss://")) {
    opts.tls = { rejectUnauthorized: false };
  }
  return opts;
}

export function createRedis(overrides: RedisOptions = {}): Redis {
  return new Redis(env.REDIS_URL, { ...baseOptions(), ...overrides });
}

export type { Redis };

let shared: Redis | null = null;
export function sharedRedis(): Redis {
  if (!shared) shared = createRedis();
  return shared;
}

export async function closeRedis(): Promise<void> {
  if (shared) {
    await shared.quit();
    shared = null;
  }
}
