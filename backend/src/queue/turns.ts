import { Queue, Worker, type Job, type Processor } from "bullmq";
import { createRedis } from "./redis.js";

/**
 * Debounced per-conversation turn queue. Inbound handler enqueues a turn job
 * with jobId = `turn:${conversationId}` and delay = BURST_WINDOW_MS. BullMQ's
 * unique-jobId behavior means rapid-fire inbound messages for the same
 * conversation collapse into a single turn — the worker runs once per burst,
 * loads all messages in context, and replies to the whole thread.
 *
 * removeOnComplete is set aggressively so the jobId is freed immediately and a
 * brand-new inbound right after the turn lands can schedule the next turn.
 */
export const TURN_QUEUE = "peach-turns";

export interface TurnJobData {
  accountId: string;
  conversationId: string;
  subscriberId: string;
  subscriberExternalId: string;
}

let queueInstance: Queue<TurnJobData> | null = null;

export function turnQueue(): Queue<TurnJobData> {
  if (!queueInstance) {
    queueInstance = new Queue<TurnJobData>(TURN_QUEUE, {
      connection: createRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        // Free the jobId immediately so a new inbound can schedule the next turn.
        removeOnComplete: true,
        removeOnFail: { count: 1000, age: 24 * 3600 },
      },
    });
  }
  return queueInstance;
}

export async function closeTurnQueue(): Promise<void> {
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
}

export function turnWorker(
  processor: Processor<TurnJobData>,
  opts: { concurrency?: number } = {},
): Worker<TurnJobData> {
  return new Worker<TurnJobData>(TURN_QUEUE, processor, {
    connection: createRedis(),
    concurrency: opts.concurrency ?? 8,
  });
}

export type TurnJob = Job<TurnJobData>;
