import { Queue, Worker, type Job, type Processor } from "bullmq";
import { createRedis } from "./redis.js";

export const OUTBOUND_QUEUE = "peach-outbound";

export type OutboundJobKind = "text" | "ppv";

export interface OutboundJobData {
  accountId: string;
  conversationId: string;
  subscriberId: string;
  subscriberExternalId: string;
  kind: OutboundJobKind;
  /** Locally-issued key that ties this outbound to an already-inserted messages row. */
  messageId: string;
  text: string;
  /** PPV payload, present only when kind=ppv. */
  ppv?: {
    assetId: string;
    assetRef: string;
    priceCents: number;
  };
  /** Sequence index within a bubble chain so logs and retries make sense. */
  bubbleIndex: number;
  bubbleCount: number;
}

let queueInstance: Queue<OutboundJobData> | null = null;

export function outboundQueue(): Queue<OutboundJobData> {
  if (!queueInstance) {
    queueInstance = new Queue<OutboundJobData>(OUTBOUND_QUEUE, {
      connection: createRedis(),
      defaultJobOptions: {
        attempts: 6,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { count: 1000, age: 24 * 3600 },
        removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
      },
    });
  }
  return queueInstance;
}

export async function closeOutboundQueue(): Promise<void> {
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
}

export function outboundWorker(
  processor: Processor<OutboundJobData>,
  opts: { concurrency?: number } = {},
): Worker<OutboundJobData> {
  return new Worker<OutboundJobData>(OUTBOUND_QUEUE, processor, {
    connection: createRedis(),
    // outbound runs lower concurrency than inbound: sends are rate-governed
    // platform-side and per-conversation ordering matters more than throughput.
    concurrency: opts.concurrency ?? 4,
  });
}

export type OutboundJob = Job<OutboundJobData>;
