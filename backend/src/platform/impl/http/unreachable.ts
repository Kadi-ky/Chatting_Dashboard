import { sharedRedis } from "../../../queue/redis.js";

/**
 * Unreachable-fan tracking. When OFAPI returns 400 "Cannot send message to
 * this user" — fan blocked us / unsubbed / disabled DMs / account suspended —
 * we record the fan in Redis so outreach + nudge workers skip them on future
 * ticks. Operator audit 2026-05-11: ~10% of cold outreach was burning sends
 * + LLM compute on these dead fans before we filtered.
 *
 * TTL is 30 days — fan state on OF can change (sub re-renewed, DM re-enabled,
 * unblock) so we don't permanently exclude. After 30d, we retry; if still
 * unreachable, the flag gets re-set on the next failed attempt.
 */

const UNREACHABLE_TTL_SECONDS = 30 * 24 * 3600; // 30 days

const key = (accountId: string, fanExternalId: string): string =>
  `peach:fan:unreachable:${accountId}:${fanExternalId}`;

export async function markFanUnreachable(
  platformAccountId: string,
  fanExternalId: string,
): Promise<void> {
  const r = sharedRedis();
  await r.set(key(platformAccountId, fanExternalId), "1", "EX", UNREACHABLE_TTL_SECONDS);
}

export async function isFanUnreachable(
  platformAccountId: string,
  fanExternalId: string,
): Promise<boolean> {
  const r = sharedRedis();
  const v = await r.get(key(platformAccountId, fanExternalId));
  return v === "1";
}
