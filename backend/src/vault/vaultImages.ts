import { PlatformHttpClient } from "../platform/impl/http/client.js";
import { sharedRedis } from "../queue/redis.js";
import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";

/**
 * Vault image source for selling individual photos as PPV.
 *
 * Discovered 2026-06-05: OnlyFansAPI exposes the creator's media vault at
 *   GET /api/{account}/media/vault?type=photo&limit=100&offset=N
 * returning items with a numeric `id` that is a REUSABLE vault media id —
 * exactly what `mediaFiles: [id]` (our PPV send path) accepts. So selling a
 * vault photo needs no new send plumbing: pick an id, attach it as the PPV
 * assetRef, price it. (Operator chose "all vault photos" as the source.)
 *
 * We list the WHOLE vault (no `list` filter), keep only ready+viewable
 * non-error photos, and cache the id list per platform-account in Redis (the
 * vault changes rarely). Per-fan dedup is a Redis set so a fan isn't sold the
 * same photo twice.
 */

const VAULT_CACHE_TTL_SEC = 6 * 3600; // refresh the photo-id list every 6h
const SENT_TTL_SEC = 90 * 24 * 3600;  // remember what a fan was sent for 90d
const PAGE_LIMIT = 100;
const MAX_PAGES = 20; // hard cap = 2,000 photos; plenty for any creator

const cacheKey = (platformAccountId: string): string => `peach:vault:photos:${platformAccountId}`;
const sentKey = (conversationId: string): string => `peach:vault:sent:${conversationId}`;

interface VaultMediaItem {
  id: number;
  type: string;
  isReady?: boolean;
  canView?: boolean;
  hasError?: boolean;
  hasPosts?: boolean;
}
interface VaultMediaResponse {
  data?: { list?: VaultMediaItem[]; hasMore?: boolean };
}

/**
 * Fetch every sellable photo id in the account's vault (paginated). Filters
 * to ready + viewable + non-error. `hasPosts` (already a public post) is kept
 * by default per operator's "all vault photos" choice, but surfaced via
 * getVaultPhotoStats so it can be excluded later if it hurts conversion.
 */
async function fetchAllVaultPhotoIds(platformAccountId: string): Promise<string[]> {
  if (env.PLATFORM_MODE === "mock") return [];
  const client = new PlatformHttpClient();
  const out: string[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await client.request<VaultMediaResponse>(
      `/api/${platformAccountId}/media/vault`,
      { query: { type: "photo", field: "recent", sort: "desc", limit: PAGE_LIMIT, offset } },
    );
    const list = resp?.data?.list ?? [];
    for (const m of list) {
      if (m.isReady && m.canView && !m.hasError) out.push(String(m.id));
    }
    if (!resp?.data?.hasMore || list.length === 0) break;
    offset += PAGE_LIMIT;
  }
  return out;
}

/** Cached list of sellable vault photo ids for an account. */
export async function getVaultPhotoIds(platformAccountId: string): Promise<string[]> {
  const r = sharedRedis();
  const k = cacheKey(platformAccountId);
  try {
    const cached = await r.get(k);
    if (cached) return JSON.parse(cached) as string[];
  } catch {
    /* fall through to refetch */
  }
  try {
    const ids = await fetchAllVaultPhotoIds(platformAccountId);
    if (ids.length > 0) {
      try {
        await r.set(k, JSON.stringify(ids), "EX", VAULT_CACHE_TTL_SEC);
      } catch {
        /* cache best-effort */
      }
    }
    return ids;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, platformAccountId },
      "vault photo list fetch failed",
    );
    return [];
  }
}

/**
 * Pick a vault photo id for this fan that we haven't already sent them. If
 * the fan has been sent every photo (small vaults), allow a repeat rather
 * than send nothing. Returns null only when the vault has no sellable photos.
 */
export async function pickVaultImageForFan(
  platformAccountId: string,
  conversationId: string,
): Promise<string | null> {
  const ids = await getVaultPhotoIds(platformAccountId);
  if (ids.length === 0) return null;
  const r = sharedRedis();
  let sent: string[] = [];
  try {
    sent = await r.smembers(sentKey(conversationId));
  } catch {
    /* treat as none sent */
  }
  const sentSet = new Set(sent);
  const fresh = ids.filter((id) => !sentSet.has(id));
  const pool = fresh.length > 0 ? fresh : ids;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/** Record that a fan was sent this vault photo (per-conversation dedup set). */
export async function recordVaultImageSent(conversationId: string, mediaId: string): Promise<void> {
  const r = sharedRedis();
  try {
    await r.sadd(sentKey(conversationId), mediaId);
    await r.expire(sentKey(conversationId), SENT_TTL_SEC);
  } catch {
    /* dedup best-effort */
  }
}

/** Force a cache refresh (used by the admin diag endpoint). */
export async function refreshVaultPhotoCache(platformAccountId: string): Promise<number> {
  const r = sharedRedis();
  try {
    await r.del(cacheKey(platformAccountId));
  } catch {
    /* ignore */
  }
  const ids = await getVaultPhotoIds(platformAccountId);
  return ids.length;
}
