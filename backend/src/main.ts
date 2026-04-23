import { env } from "./config/index.js";
import { closeDb, db } from "./db/client.js";
import { closeRedis, sharedRedis } from "./queue/redis.js";
import { closeInboundQueue } from "./queue/inbound.js";
import { closeOutboundQueue } from "./queue/outbound.js";
import { closeTurnQueue } from "./queue/turns.js";
import { logger } from "./observability/logger.js";
import { startPoller, type PollerHandle } from "./ingress/poller.js";
import { startConversationWorker } from "./worker/conversationWorker.js";
import { startTurnWorker } from "./worker/turnWorker.js";
import { startSendWorker } from "./worker/sendWorker.js";
import { startBroadcastRunner, type BroadcastRunnerHandle } from "./worker/broadcastWorker.js";
import { startAdminServer, type AdminServerHandle } from "./api/server.js";
import { getPlatformAdapter } from "./platform/index.js";
import type { Worker } from "bullmq";
import type { InboundJobData } from "./queue/inbound.js";
import type { OutboundJobData } from "./queue/outbound.js";
import type { TurnJobData } from "./queue/turns.js";

let poller: PollerHandle | null = null;
let worker: Worker<InboundJobData> | null = null;
let turnWorkerRef: Worker<TurnJobData> | null = null;
let sendWorker: Worker<OutboundJobData> | null = null;
let broadcastRunner: BroadcastRunnerHandle | null = null;
let adminServer: AdminServerHandle | null = null;

async function preflight(): Promise<void> {
  const r = sharedRedis();
  await r.ping();
  logger.debug("redis ok");

  const row = await db
    .selectFrom("v3.accounts")
    .select(db.fn.count<string>("id").as("count"))
    .where("id", "=", env.ACCOUNT_ID)
    .executeTakeFirst();
  if (Number(row?.count ?? 0) !== 1) {
    throw new Error(
      `ACCOUNT_ID ${env.ACCOUNT_ID} has no matching row in v3.accounts — seed one before running the service.`,
    );
  }
  logger.debug("account ok");
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  try {
    if (poller) await poller.stop();
    if (broadcastRunner) await broadcastRunner.stop();
    if (adminServer) await adminServer.stop();
    if (worker) await worker.close();
    if (turnWorkerRef) await turnWorkerRef.close();
    if (sendWorker) await sendWorker.close();
    await Promise.allSettled([closeInboundQueue(), closeTurnQueue(), closeOutboundQueue()]);
    await Promise.allSettled([closeRedis(), closeDb()]);
  } catch (err) {
    logger.error({ err }, "shutdown error");
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "unhandled rejection");
});

async function boot(): Promise<void> {
  logger.info({ account: env.ACCOUNT_ID, nodeEnv: env.NODE_ENV }, "boot");
  await preflight();
  worker = startConversationWorker();
  turnWorkerRef = startTurnWorker();
  sendWorker = startSendWorker({ adapter: getPlatformAdapter() });
  broadcastRunner = startBroadcastRunner();
  adminServer = startAdminServer();
  poller = startPoller();
  logger.info("service up");
}

boot().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "boot failed");
  void shutdown("boot-error");
});
