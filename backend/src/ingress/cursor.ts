import { sharedRedis } from "../queue/redis.js";

const key = (accountId: string) => `ingress:cursor:${accountId}`;

export async function readCursor(accountId: string): Promise<string | null> {
  return await sharedRedis().get(key(accountId));
}

export async function writeCursor(accountId: string, cursor: string): Promise<void> {
  await sharedRedis().set(key(accountId), cursor);
}
