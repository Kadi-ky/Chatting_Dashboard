import type { Redis } from "ioredis";
import { sharedRedis } from "./redis.js";

export interface RateLimiterOptions {
  /** Unique key per bucket (e.g. `send:${accountId}`). */
  key: string;
  /** Bucket size — max burst. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export interface AcquireResult {
  ok: boolean;
  /** If ok=false, retryAfterMs is how long caller should wait before retrying. */
  retryAfterMs: number;
  /** Remaining tokens after the acquire attempt. */
  remaining: number;
}

/**
 * Token bucket rate limiter with Redis-atomic refill. One Lua script evaluates
 * refill + acquire atomically so concurrent workers can't double-spend.
 *
 * Key layout: HSET at `<key>`: tokens, lastRefillMs
 * TTL refreshed on every call to 1 hour (keys are harmless if they reset).
 */
const SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
local tokens = tonumber(data[1])
local last = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last = nowMs
end

local elapsed = math.max(0, nowMs - last)
tokens = math.min(capacity, tokens + elapsed * (refillPerSec / 1000.0))

local ok = 0
local retryMs = 0
if tokens >= cost then
  tokens = tokens - cost
  ok = 1
else
  local deficit = cost - tokens
  retryMs = math.ceil(deficit / (refillPerSec / 1000.0))
end

redis.call('HMSET', key, 'tokens', tokens, 'lastRefillMs', nowMs)
redis.call('PEXPIRE', key, 3600000)
return { ok, retryMs, tokens }
`;

export class TokenBucketRateLimiter {
  private readonly redis: Redis;
  constructor(
    private readonly opts: RateLimiterOptions,
    redis: Redis = sharedRedis(),
  ) {
    this.redis = redis;
  }

  async tryAcquire(cost = 1): Promise<AcquireResult> {
    const res = (await this.redis.eval(
      SCRIPT,
      1,
      this.opts.key,
      String(this.opts.capacity),
      String(this.opts.refillPerSec),
      String(Date.now()),
      String(cost),
    )) as [number, number, number];
    return { ok: res[0] === 1, retryAfterMs: Number(res[1]), remaining: Number(res[2]) };
  }
}

/**
 * Per-conversation minimum gap enforcer. Independent from the account-wide
 * token bucket: guarantees at least `minGapMs` between any two sends to the
 * same subscriber (overridable by callers who are sending a deliberate
 * bubble chain with explicit sub-gap delays).
 */
export class ConversationGap {
  constructor(
    private readonly redis: Redis = sharedRedis(),
    private readonly minGapMs: number = 20_000,
  ) {}

  /** Returns 0 if safe to send now; otherwise ms to wait. */
  async msUntilAllowed(conversationId: string): Promise<number> {
    const key = `outbound:last:${conversationId}`;
    const last = await this.redis.get(key);
    if (!last) return 0;
    const elapsed = Date.now() - Number(last);
    if (elapsed >= this.minGapMs) return 0;
    return this.minGapMs - elapsed;
  }

  async markSent(conversationId: string): Promise<void> {
    const key = `outbound:last:${conversationId}`;
    await this.redis.set(key, String(Date.now()), "PX", Math.max(60_000, this.minGapMs * 4));
  }
}

/**
 * Atomic per-conversation send mutex. Prevents two outbound workers from
 * racing when sending bubbles for the same conversation, which produced
 * out-of-order bubble delivery under concurrency > 1.
 *
 * acquire() uses SET NX PX — atomic ownership check. release() uses a Lua
 * check-and-delete so a lock that outlived its TTL and was re-acquired by
 * someone else isn't accidentally freed by the original holder.
 */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export class ConversationSendLock {
  constructor(
    private readonly redis: Redis = sharedRedis(),
    private readonly ttlMs: number = 30_000,
  ) {}

  /** Returns an opaque token on success, or null if the lock is held elsewhere. */
  async tryAcquire(conversationId: string): Promise<string | null> {
    const key = `outbound:lock:${conversationId}`;
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const res = await this.redis.set(key, token, "PX", this.ttlMs, "NX");
    return res === "OK" ? token : null;
  }

  async release(conversationId: string, token: string): Promise<void> {
    const key = `outbound:lock:${conversationId}`;
    await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
  }
}
