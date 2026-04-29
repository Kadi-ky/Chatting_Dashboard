import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import { db } from "../db/client.js";
import { sharedRedis } from "../queue/redis.js";
import { getPlatformAdapter } from "../platform/index.js";
import { upsertSubscriber } from "../db/repos/subscribers.js";
import { loadAccountById } from "../db/repos/accounts.js";

/**
 * Subscriber-sync worker.
 *
 * Operator data 2026-04-30: V3 has 338 subs in v3.subscribers but the OF
 * account has ~2000 real subscribers. The gap = lurkers who never came
 * through any webhook (so conversationWorker.upsertSubscriber never ran
 * for them). Cold outreach can only target what's in our DB; without
 * sync it has 1 candidate.
 *
 * This worker calls OFAPI's /fans endpoint via adapter.listSubscribers,
 * iterates pages, and upserts every fan into v3.subscribers. After one
 * successful sync the cold-outreach worker will see the full set.
 *
 * Cadence: every SUB_SYNC_INTERVAL_MS (default 6h). Per-account Redis
 * lock prevents concurrent runs across worker restarts. Adapter calls
 * already pace themselves via the per-account token bucket so this
 * won't trip 429s.
 *
 * Safety:
 *   - SUB_SYNC_ENABLED env defaults false (master kill).
 *   - SUB_SYNC_INTERVAL_MS configurable; default 6h.
 *   - Per-account run lock with 1h TTL (sync should complete in <5 min;
 *     lock auto-expires if process dies).
 *   - Skips accounts without a real OFAPI acct_* id.
 *   - upsertSubscriber is idempotent — re-runs are safe.
 */

const TICK_MS = Number(process.env.SUB_SYNC_INTERVAL_MS) || 6 * 3600_000;
const STARTUP_DELAY_MS = 2 * 60_000;
const LOCK_TTL_SEC = 3600; // 1h lock per account

const lockKey = (accountId: string): string => `peach:subsync:lock:${accountId}`;

interface SyncStats {
  accountId: string;
  platformAccountId: string;
  fansSeen: number;
  errors: number;
  durationMs: number;
}

interface RecentSync {
  at: string;
  accountId: string;
  fansSeen: number;
  errors: number;
  durationMs: number;
}
const RECENT_SYNCS: RecentSync[] = [];
const RECENT_SYNCS_MAX = 20;
export function getRecentSubSyncs(): RecentSync[] {
  return RECENT_SYNCS.slice();
}

async function syncAccount(accountId: string): Promise<SyncStats | null> {
  const r = sharedRedis();
  const acquired = await r.set(lockKey(accountId), "1", "EX", LOCK_TTL_SEC, "NX");
  if (acquired !== "OK") {
    logger.debug({ accountId }, "subsync lock held — skipping (another worker syncing)");
    return null;
  }

  const account = await loadAccountById(accountId);
  if (!account || !account.platformAccountId || !account.platformAccountId.startsWith("acct_")) {
    logger.warn(
      { accountId, platformAccountId: account?.platformAccountId },
      "subsync skipped — account missing real OFAPI acct_ id",
    );
    return null;
  }

  const adapter = getPlatformAdapter();
  const ctx = { accountId, platformAccountId: account.platformAccountId };

  const startedAt = Date.now();
  let fansSeen = 0;
  let errors = 0;

  try {
    for await (const fan of adapter.listSubscribers(ctx)) {
      try {
        await upsertSubscriber({
          accountId,
          externalId: fan.externalId,
          ...(fan.displayName ? { displayName: fan.displayName } : {}),
          metadata: fan.metadata,
        });
        fansSeen++;
      } catch (err) {
        errors++;
        logger.warn(
          { err: err instanceof Error ? err.message : err, fanExternalId: fan.externalId },
          "subsync upsert failed for one fan",
        );
      }
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, accountId },
      "subsync listSubscribers failed",
    );
    errors++;
  }

  const stats: SyncStats = {
    accountId,
    platformAccountId: account.platformAccountId,
    fansSeen,
    errors,
    durationMs: Date.now() - startedAt,
  };

  const recent: RecentSync = {
    at: new Date().toISOString(),
    accountId,
    fansSeen,
    errors,
    durationMs: stats.durationMs,
  };
  RECENT_SYNCS.unshift(recent);
  if (RECENT_SYNCS.length > RECENT_SYNCS_MAX) RECENT_SYNCS.length = RECENT_SYNCS_MAX;

  logger.info(stats, "subsync complete");
  return stats;
}

/**
 * Pull the list of accounts to sync. Driven by the
 * platform_account_allowlist env (same allowlist that gates webhook
 * ingress). Defensive: filters to real acct_ ids only.
 *
 * Status filter intentionally NOT applied — operator runs may have
 * accounts with status 'shadow' or other values and we still want to
 * sync them. The allowlist itself is the gate.
 */
async function listAllowedAccounts(): Promise<{ accounts: string[]; reason?: string }> {
  const allowlist = env.PLATFORM_ACCOUNT_ALLOWLIST?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("acct_")) ?? [];
  if (allowlist.length === 0) {
    return { accounts: [], reason: "PLATFORM_ACCOUNT_ALLOWLIST env is empty or contains no acct_ ids" };
  }
  const rows = await db
    .selectFrom("v3.accounts")
    .select(["id", "platform_account_id", "status"])
    .where("platform_account_id", "in", allowlist)
    .execute();
  if (rows.length === 0) {
    return {
      accounts: [],
      reason: `no v3.accounts rows match allowlist (${allowlist.join(",")}). Run upsert against v3.accounts or check platform_account_id values.`,
    };
  }
  return { accounts: rows.map((r) => r.id) };
}

export interface SubSyncWorkerHandle {
  stop: () => Promise<void>;
}

export function startSubSyncWorker(): SubSyncWorkerHandle | null {
  if (!env.SUB_SYNC_ENABLED) {
    logger.info("sub-sync worker disabled (SUB_SYNC_ENABLED=false)");
    return null;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const { accounts, reason } = await listAllowedAccounts();
      if (accounts.length === 0) {
        logger.debug({ reason }, "subsync tick — no allowed accounts");
      } else {
        for (const accountId of accounts) {
          await syncAccount(accountId);
        }
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "subsync tick failed",
      );
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_MS);
    }
  };

  timer = setTimeout(tick, STARTUP_DELAY_MS);
  logger.info({ tickMs: TICK_MS }, "sub-sync worker started");

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Manual trigger — bypasses the schedule. Used by the
 * /admin/subsync-now endpoint so the operator can force a sync without
 * waiting for the next tick.
 *
 * Returns { syncs, skipped, reason } so an empty syncs array can be
 * diagnosed instead of looking silently broken.
 */
export interface ManualSyncResult {
  syncs: SyncStats[];
  candidates: number;
  skippedAccounts: string[];
  reason?: string;
}

export async function triggerSubSyncNow(): Promise<ManualSyncResult> {
  const { accounts, reason } = await listAllowedAccounts();
  if (accounts.length === 0) {
    return { syncs: [], candidates: 0, skippedAccounts: [], ...(reason ? { reason } : {}) };
  }
  const results: SyncStats[] = [];
  const skipped: string[] = [];
  for (const accountId of accounts) {
    const r = await syncAccount(accountId);
    if (r) results.push(r);
    else skipped.push(accountId);
  }
  return {
    syncs: results,
    candidates: accounts.length,
    skippedAccounts: skipped,
    ...(skipped.length > 0
      ? { reason: `${skipped.length} accounts skipped — likely Redis lock held (TTL=1h) OR account missing real acct_ id. Check Railway logs for "subsync skipped" / "subsync lock held".` }
      : {}),
  };
}
