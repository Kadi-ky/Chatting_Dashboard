import { sql, type SqlBool } from "kysely";
import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import { db } from "../db/client.js";
import { sharedRedis } from "../queue/redis.js";
import { turnQueue } from "../queue/turns.js";

/**
 * Reply-recovery sweep — the safety net that guarantees every fan message gets
 * answered. The turn queue uses removeOnFail:true (turns.ts), so a turn that
 * fails all 3 attempts (e.g. a transient OpenRouter/Hermes timeout) is silently
 * deleted and the fan's message is dropped with NO reply and NO retry. Verified
 * in production 2026-06-09: a genuine QUALIFYING fan sat unanswered 24 min
 * because their turn failed; only a manual /admin/replay-stuck-convs recovered
 * it. This worker runs that recovery automatically.
 *
 * Each tick it finds conversations whose LATEST message is inbound (fan spoke
 * last, no reply) within a rolling window, and re-enqueues a turn. It is NOT
 * proactive outreach — it only replies to messages a fan ALREADY sent; it never
 * touches a quiet/cold fan.
 *
 * Race + waste guards:
 *   - minAge floor: only convs stuck longer than the normal debounce+processing
 *     time, so we never race an in-flight reply.
 *   - jobId `turn-${convId}` (same as the normal path) → BullMQ dedups against
 *     any turn still scheduled/active for that conv; only genuinely-dropped
 *     convs (jobId freed by removeOnFail) get a fresh turn.
 *   - per-conv Redis cooldown: a conv is re-fired at most once per cooldown, so
 *     a permanently-unreplyable conv (spam/bot the pipeline correctly skips)
 *     isn't retried every tick — it ages out of the window after a few tries.
 */

const TICK_MS = 10 * 60_000;            // sweep every 10 min
const STARTUP_DELAY_MS = 100_000;       // ~100s — let other workers settle first
const MIN_AGE_MS = 5 * 60_000;          // ignore convs stuck < 5 min (normal reply still in flight)
const MAX_AGE_MS = 90 * 60_000;         // ignore convs stuck > 90 min (aged out — stop retrying)
const RECOVERY_COOLDOWN_SEC = 30 * 60;  // re-fire a given conv at most once per 30 min
const MAX_PER_TICK = 200;               // safety cap

const cooldownKey = (conversationId: string): string => `peach:recovery:${conversationId}`;

// Recent-fires diag ring.
interface RecentRecovery {
  at: string;
  conversationId: string;
  subscriberExternalId: string;
  lastMessageAt: string;
}
const RECENT_RECOVERIES: RecentRecovery[] = [];
const RECENT_RECOVERIES_MAX = 50;
export function getRecentRecoveries(): RecentRecovery[] {
  return RECENT_RECOVERIES.slice();
}

interface RecoveryResult {
  candidates: number;
  recovered: number;
  skippedCooldown: number;
}

export async function runReplyRecoveryPass(): Promise<RecoveryResult> {
  const now = Date.now();
  const newerThan = new Date(now - MAX_AGE_MS);
  const olderThan = new Date(now - MIN_AGE_MS);

  // Conversations whose latest message is inbound, last inbound within the
  // [MIN_AGE, MAX_AGE] window. Same distinct-on-latest shape as the manual
  // /admin/replay-stuck-convs endpoint.
  const stuck = await db
    .selectFrom("v3.conversations as c")
    .innerJoin(
      db
        .selectFrom("v3.messages")
        .select(["conversation_id", "direction", "created_at"])
        .distinctOn(["conversation_id"])
        .orderBy("conversation_id")
        .orderBy("created_at", "desc")
        .as("latest"),
      "latest.conversation_id",
      "c.id",
    )
    .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
    .select([
      "c.id as conversationId",
      "c.account_id as accountId",
      "c.subscriber_id as subscriberId",
      "s.external_id as subscriberExternalId",
      "latest.created_at as lastMessageAt",
    ])
    .where("latest.direction", "=", "inbound")
    .where(sql<SqlBool>`latest.created_at > ${newerThan}`)
    .where(sql<SqlBool>`latest.created_at < ${olderThan}`)
    .execute();

  const result: RecoveryResult = { candidates: stuck.length, recovered: 0, skippedCooldown: 0 };
  const r = sharedRedis();

  for (const row of stuck) {
    if (result.recovered >= MAX_PER_TICK) break;
    const convId = row.conversationId as string;
    try {
      // Per-conv cooldown so a perpetually-stuck conv isn't re-fired every tick.
      const set = await r.set(cooldownKey(convId), "1", "EX", RECOVERY_COOLDOWN_SEC, "NX");
      if (set !== "OK") {
        result.skippedCooldown++;
        continue;
      }
      await turnQueue().add(
        "turn",
        {
          accountId: row.accountId as string,
          conversationId: convId,
          subscriberId: row.subscriberId as string,
          subscriberExternalId: row.subscriberExternalId as string,
        },
        // Same jobId as the normal path → dedups against any in-flight turn.
        { jobId: `turn-${convId}`, delay: 1000 },
      );
      const entry: RecentRecovery = {
        at: new Date().toISOString(),
        conversationId: convId,
        subscriberExternalId: row.subscriberExternalId as string,
        lastMessageAt: (row.lastMessageAt as unknown as Date)?.toISOString?.() ?? String(row.lastMessageAt),
      };
      RECENT_RECOVERIES.unshift(entry);
      if (RECENT_RECOVERIES.length > RECENT_RECOVERIES_MAX) RECENT_RECOVERIES.length = RECENT_RECOVERIES_MAX;
      result.recovered++;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, conversationId: convId },
        "reply-recovery failed for one conv",
      );
    }
  }

  if (result.recovered > 0) {
    logger.info(result, "reply-recovery: re-queued dropped turns");
  }
  return result;
}

/** Manual trigger for /admin/reply-recovery-now. */
export async function triggerReplyRecoveryNow(): Promise<RecoveryResult> {
  return runReplyRecoveryPass();
}

export interface ReplyRecoveryWorkerHandle {
  stop: () => Promise<void>;
}

export function startReplyRecoveryWorker(): ReplyRecoveryWorkerHandle | null {
  // Default ON — this is a reliability safety net, not a sending feature. It
  // only re-answers messages fans already sent. Kill with REPLY_RECOVERY_ENABLED=false.
  if (!env.REPLY_RECOVERY_ENABLED) {
    logger.info("reply-recovery worker disabled (REPLY_RECOVERY_ENABLED=false)");
    return null;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runReplyRecoveryPass();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "reply-recovery tick failed");
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_MS);
    }
  };

  timer = setTimeout(tick, STARTUP_DELAY_MS);
  logger.info({ tickMs: TICK_MS }, "reply-recovery worker started");

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
