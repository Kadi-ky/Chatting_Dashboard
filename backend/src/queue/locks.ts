import { randomUUID } from "node:crypto";
import { sharedRedis } from "./redis.js";
import { env } from "../config/index.js";

const lockKey = (id: string) => `lock:conv:${id}`;

/**
 * Redis-backed mutex. `acquire` returns null if another holder has the lock.
 * `release` only releases if the token matches — so a stale holder whose TTL
 * has expired cannot stomp a new holder's lock.
 */
export async function acquireConversationLock(
  conversationId: string,
  ttlMs: number = env.CONVERSATION_LOCK_TTL_MS,
): Promise<string | null> {
  const token = randomUUID();
  const ok = await sharedRedis().set(lockKey(conversationId), token, "PX", ttlMs, "NX");
  return ok === "OK" ? token : null;
}

const releaseScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export async function releaseConversationLock(
  conversationId: string,
  token: string,
): Promise<boolean> {
  const res = (await sharedRedis().eval(releaseScript, 1, lockKey(conversationId), token)) as number;
  return res === 1;
}

export async function withConversationLock<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const token = await acquireConversationLock(conversationId);
  if (!token) return null;
  try {
    return await fn();
  } finally {
    await releaseConversationLock(conversationId, token);
  }
}
