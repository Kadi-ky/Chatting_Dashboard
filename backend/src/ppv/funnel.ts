import { sharedRedis } from "../queue/redis.js";

/**
 * Per-(conversation, asset) two-turn pitch funnel state.
 *
 * Each rung of the catalog ladder is sold across TWO turns:
 *   Turn N   — bot sends the FREE PREVIEW with a tease caption ("look at this …
 *              wait til u see what's after")
 *   Turn N+1 — fan reacts; bot sends the PRICED PPV with its own caption
 *
 * This avoids the awkward "rapport → boom, here's a paid PPV" flow. Mirrors
 * the n8n `funnel_tracking_onlyfans.status` field.
 *
 * State is Redis-only because:
 *   - it's session-scoped (decays with conversation activity)
 *   - encoding it on v3.ppv_attempts would need a schema migration + breaks
 *     the "one row per priced pitch" semantics other code relies on
 *   - 24h TTL handles long-quiet conversations naturally — a fan who came back
 *     a week later starts the funnel fresh, which is what we want
 */

export type FunnelStep = "none" | "preview_sent" | "ppv_sent";

const TTL_SECONDS = 24 * 3600;

function key(conversationId: string, assetId: string): string {
  return `pitch:funnel:${conversationId}:${assetId}`;
}

/**
 * What's the current funnel state for this (conversation, asset)?
 *   "none"          — nothing sent yet for this rung; next pitch should be the preview
 *   "preview_sent"  — preview is out, waiting for fan to react; next pitch is the PPV
 *   "ppv_sent"      — priced PPV out; either fan unlocks (advance to next rung)
 *                     or it ages out (drip / recovery handles re-engagement)
 */
export async function getFunnelStep(
  conversationId: string,
  assetId: string,
): Promise<FunnelStep> {
  const r = sharedRedis();
  const v = await r.get(key(conversationId, assetId));
  if (v === "preview_sent" || v === "ppv_sent") return v;
  return "none";
}

export async function markPreviewSent(
  conversationId: string,
  assetId: string,
): Promise<void> {
  const r = sharedRedis();
  await r.set(key(conversationId, assetId), "preview_sent", "EX", TTL_SECONDS);
}

export async function markPpvSent(
  conversationId: string,
  assetId: string,
): Promise<void> {
  const r = sharedRedis();
  await r.set(key(conversationId, assetId), "ppv_sent", "EX", TTL_SECONDS);
}

/** Wipe state for a rung — call when the fan unlocks so the next rung can start fresh. */
export async function clearFunnel(
  conversationId: string,
  assetId: string,
): Promise<void> {
  const r = sharedRedis();
  await r.del(key(conversationId, assetId));
}
