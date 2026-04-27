import { DelayedError, UnrecoverableError, type Worker } from "bullmq";
import { PlatformHttpError } from "../platform/impl/http/client.js";
import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import {
  outboundWorker,
  type OutboundJob,
  type OutboundJobData,
} from "../queue/outbound.js";
import { TokenBucketRateLimiter, ConversationGap, ConversationSendLock } from "../queue/rate_limit.js";
import type { PlatformAdapter, SendResult } from "../platform/PlatformAdapter.js";
import { markMessageSent } from "../db/repos/messages.js";
import { markLastOutbound } from "../db/repos/subscribers.js";
import { touchConversation } from "../db/repos/conversations.js";
import { loadAccountById } from "../db/repos/accounts.js";
import { metrics } from "../observability/metrics.js";

export interface SendWorkerDeps {
  adapter: PlatformAdapter;
}

export function startSendWorker(deps: SendWorkerDeps): Worker<OutboundJobData> {
  // Per-account token bucket cache — each account gets its own rate bucket,
  // lazily created on first job. Shared Redis backend so rate limits hold
  // across multiple worker processes for the same account.
  const buckets = new Map<string, TokenBucketRateLimiter>();
  const bucketFor = (accountId: string): TokenBucketRateLimiter => {
    let b = buckets.get(accountId);
    if (!b) {
      // OnlyFans-Native rate limit (Cloudflare 1015): we hit 429s when sending
      // even ~3-5 messages within ~30s on a single creator account. Tuning
      // for that — capacity 3, refill 1 token per 30s (so sustained ~2/min,
      // burst 3). Was 20 capacity / 1 token per 5s which DEFINITELY tripped OF.
      b = new TokenBucketRateLimiter({
        key: `send:${accountId}`,
        capacity: 3,
        refillPerSec: 1 / 30,
      });
      buckets.set(accountId, b);
    }
    return b;
  };
  const conversationGap = new ConversationGap(undefined, env.OUTBOUND_MIN_GAP_MS);
  const sendLock = new ConversationSendLock();

  const w = outboundWorker(async (job: OutboundJob, token) => {
    const data = job.data;
    const ctx = {
      conversationId: data.conversationId,
      messageId: data.messageId,
      bubble: `${data.bubbleIndex + 1}/${data.bubbleCount}`,
    };

    // Per-conversation mutex. Stops concurrent workers from racing on the
    // same conversation and producing out-of-order bubbles. If another
    // worker holds the lock, requeue ourselves shortly.
    const lockToken = await sendLock.tryAcquire(data.conversationId);
    if (!lockToken) {
      logger.debug(ctx, "conversation send lock held; delaying");
      await job.moveToDelayed(Date.now() + 250, token);
      throw new DelayedError();
    }

    try {
      // Per-conversation gap (cheap, local Redis GET). If blocked, delay
      // the job rather than busy-looping — BullMQ will re-enqueue it for us.
      const gapWait = await conversationGap.msUntilAllowed(data.conversationId);
      if (gapWait > 0) {
        logger.debug({ ...ctx, gapWait }, "conversation gap not yet elapsed; delaying");
        await job.moveToDelayed(Date.now() + gapWait, token);
        throw new DelayedError();
      }

      // Per-account token bucket.
      const acquired = await bucketFor(data.accountId).tryAcquire();
      if (!acquired.ok) {
        logger.debug({ ...ctx, retry: acquired.retryAfterMs }, "account bucket empty; delaying");
        await job.moveToDelayed(Date.now() + Math.max(250, acquired.retryAfterMs), token);
        throw new DelayedError();
      }

      // Resolve the account's platform id once per job. Mock mode can skip —
      // the mock adapter ignores AccountContext values anyway.
      const account = await loadAccountById(data.accountId);
      const platformAccountId = account?.platformAccountId ?? "mock";
      const adapterCtx = { accountId: data.accountId, platformAccountId };

      const idempotencyKey = `${data.messageId}:${data.bubbleIndex}`;
      let result: SendResult;
      try {
        if (data.kind === "ppv" && data.ppv) {
          result = await deps.adapter.sendPPV(adapterCtx, {
            subscriberExternalId: data.subscriberExternalId,
            assetRef: data.ppv.assetRef,
            priceCents: data.ppv.priceCents,
            caption: data.text,
            idempotencyKey,
          });
        } else {
          result = await deps.adapter.sendMessage(adapterCtx, {
            subscriberExternalId: data.subscriberExternalId,
            text: data.text,
            idempotencyKey,
          });
        }
      } catch (err) {
        metrics.outboundFailures.inc();
        logger.error({ ...ctx, err: err instanceof Error ? err.message : err }, "send failed");
        // Don't auto-retry rate-limit (429) or auth (401/403) errors.
        // - 429: retrying immediately makes the rate limit WORSE (cf-rate-limit
        //   compounds). Better to drop this one reply; the next fan message
        //   will trigger a fresh attempt naturally spaced apart.
        // - 401/403: token rotated or revoked — retries won't fix that.
        // Throwing UnrecoverableError tells BullMQ to mark the job failed
        // permanently and skip remaining attempts.
        if (err instanceof PlatformHttpError && (err.status === 429 || err.status === 401 || err.status === 403)) {
          throw new UnrecoverableError(err.message);
        }
        throw err;
      }

      await Promise.all([
        markMessageSent(data.messageId, result.externalId, result.sentAt),
        markLastOutbound(data.subscriberId, result.sentAt),
        touchConversation(data.conversationId),
        conversationGap.markSent(data.conversationId),
      ]);
      metrics.outboundSends.inc();

      logger.info({ ...ctx, externalId: result.externalId }, "sent");
    } finally {
      await sendLock.release(data.conversationId, lockToken);
    }
  });

  w.on("failed", (job, err) => {
    if (err?.name === "DelayedError") return; // expected delay path
    logger.error({ jobId: job?.id, err: err?.message }, "outbound job failed");
  });

  logger.info("send worker started");
  return w;
}
