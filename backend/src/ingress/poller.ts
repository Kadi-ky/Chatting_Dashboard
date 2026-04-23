import { logger } from "../observability/logger.js";
import { getPlatformAdapter } from "../platform/index.js";
import { inboundQueue, serializeEvent } from "../queue/inbound.js";
import { readCursor, writeCursor } from "./cursor.js";
import { listActiveAccounts, type AccountRow } from "../db/repos/accounts.js";

export interface PollerHandle {
  stop: () => Promise<void>;
}

/**
 * Multi-account catchup poller. Iterates every active account each tick and
 * drains its inbox since the per-account cursor. Safe to run alongside the
 * webhook ingress — both enqueue via idempotent jobIds keyed by event id.
 */
export function startPoller(options: { intervalMs?: number } = {}): PollerHandle {
  const interval = options.intervalMs ?? 3_000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollOnce();
    } catch (err) {
      logger.error({ err }, "poller tick failed");
    } finally {
      if (!stopped) timer = setTimeout(tick, interval);
    }
  };

  timer = setTimeout(tick, 0);
  logger.info({ interval }, "poller started");

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function pollOnce(): Promise<void> {
  const accounts = await listActiveAccounts();
  if (accounts.length === 0) return;
  // Fan-out across accounts; each account has its own cursor and can be
  // drained independently. Failures on one account don't block the others.
  await Promise.all(
    accounts.map((a) =>
      pollAccount(a).catch((err) => {
        logger.warn(
          { accountId: a.id, err: err instanceof Error ? err.message : err },
          "poll for account failed",
        );
      }),
    ),
  );
}

async function pollAccount(account: AccountRow): Promise<void> {
  // Accounts without a platform id aren't connected yet (still provisioning).
  if (!account.platformAccountId) return;

  const adapter = getPlatformAdapter();
  const q = inboundQueue();
  const cursor = await readCursor(account.id);

  let next: string | null = cursor;
  let keepGoing = true;
  let added = 0;

  while (keepGoing) {
    const { events, nextCursor, hasMore } = await adapter.fetchMissedSince(
      { accountId: account.id, platformAccountId: account.platformAccountId },
      next,
    );
    if (events.length > 0) {
      await q.addBulk(
        events.map((e) => ({
          name: e.kind,
          data: { accountId: account.id, event: serializeEvent(e) },
          opts: {
            jobId: `${e.kind}-${e.externalId}`, // idempotent enqueue
          },
        })),
      );
      added += events.length;
    }
    await writeCursor(account.id, nextCursor);
    next = nextCursor;
    keepGoing = hasMore;
  }

  if (added > 0) logger.info({ accountId: account.id, added }, "poller enqueued events");
}
