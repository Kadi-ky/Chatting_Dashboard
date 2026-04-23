import { sharedRedis } from "../queue/redis.js";

/**
 * Per-conversation pause flag. When set, the conversation worker skips the
 * reply pipeline and leaves the inbound message on record — operators are
 * driving the conversation manually in the UI. Takeovers auto-expire so a
 * forgotten toggle doesn't silently break replies forever.
 */

const KEY_PREFIX = "peach:takeover:";
const DEFAULT_TTL_SEC = 6 * 3600; // 6 hours

export async function enableTakeover(
  conversationId: string,
  ttlSec = DEFAULT_TTL_SEC,
): Promise<void> {
  await sharedRedis().set(`${KEY_PREFIX}${conversationId}`, "1", "EX", ttlSec);
}

export async function disableTakeover(conversationId: string): Promise<void> {
  await sharedRedis().del(`${KEY_PREFIX}${conversationId}`);
}

export async function isTakenOver(conversationId: string): Promise<boolean> {
  const v = await sharedRedis().get(`${KEY_PREFIX}${conversationId}`);
  return v !== null;
}
