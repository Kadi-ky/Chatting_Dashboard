import { Queue, Worker, type Job, type Processor } from "bullmq";
import { createRedis } from "./redis.js";
import type { PlatformEvent } from "../platform/PlatformAdapter.js";

export const INBOUND_QUEUE = "peach-inbound";

export interface InboundJobData {
  accountId: string;
  event: SerializedPlatformEvent;
}

export interface SerializedPlatformEvent
  extends Omit<PlatformEvent, "occurredAt"> {
  occurredAt: string;
}

export function serializeEvent(e: PlatformEvent): SerializedPlatformEvent {
  return { ...e, occurredAt: e.occurredAt.toISOString() };
}

export function deserializeEvent(e: SerializedPlatformEvent): PlatformEvent {
  return { ...e, occurredAt: new Date(e.occurredAt) };
}

let queueInstance: Queue<InboundJobData> | null = null;

export function inboundQueue(): Queue<InboundJobData> {
  if (!queueInstance) {
    queueInstance = new Queue<InboundJobData>(INBOUND_QUEUE, {
      connection: createRedis(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { count: 1000, age: 24 * 3600 },
        removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
      },
    });
  }
  return queueInstance;
}

export async function closeInboundQueue(): Promise<void> {
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
}

export function inboundWorker(
  processor: Processor<InboundJobData>,
  opts: { concurrency?: number } = {},
): Worker<InboundJobData> {
  return new Worker<InboundJobData>(INBOUND_QUEUE, processor, {
    connection: createRedis(),
    concurrency: opts.concurrency ?? 10,
  });
}

export type InboundJob = Job<InboundJobData>;
