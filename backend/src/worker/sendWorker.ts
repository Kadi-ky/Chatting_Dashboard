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
import { sharedRedis } from "../queue/redis.js";

/**
 * Account-level cooldown after 429. When set, ALL outbound jobs to this
 * account get delayed until the key expires. Stops the "every queued
 * message individually hits 429" cascade where a single rate-limit window
 * burns through dozens of retries.
 */
const ACCOUNT_COOLDOWN_KEY = (accountId: string): string => `acct_cooldown:${accountId}`;
const ACCOUNT_COOLDOWN_MS = 5 * 60_000; // pause an account for 5 min after a 429

async function getAccountCooldownMs(accountId: string): Promise<number> {
  const ttl = await sharedRedis().pttl(ACCOUNT_COOLDOWN_KEY(accountId));
  return ttl > 0 ? ttl : 0;
}

async function setAccountCooldown(accountId: string): Promise<void> {
  await sharedRedis().set(ACCOUNT_COOLDOWN_KEY(accountId), "1", "PX", ACCOUNT_COOLDOWN_MS);
}

/** True when SEND_RAMP_UP_UNTIL is set + still in the future. */
function isInRampUp(): boolean {
  const raw = process.env.SEND_RAMP_UP_UNTIL;
  if (!raw) return false;
  const target = Date.parse(raw);
  if (!Number.isFinite(target)) return false;
  return Date.now() < target;
}
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
      //
      // RAMP-UP MODE: when SEND_RAMP_UP_UNTIL is set + future, halve the rate
      // (1 token per 60s, sustained 1/min). Used after un-pausing a flagged
      // account so OF's elevated-cooldown flag fully clears.
      const inRampUp = isInRampUp();
      b = new TokenBucketRateLimiter({
        key: `send:${accountId}`,
        capacity: inRampUp ? 2 : 3,
        refillPerSec: inRampUp ? 1 / 60 : 1 / 30,
      });
      buckets.set(accountId, b);
    }
    // If we crossed the ramp-up boundary, recreate the bucket with normal
    // limits. Cheap to reset; happens at most once per worker lifetime.
    return b;
  };

  // Reset buckets whenever ramp-up status flips. Cheap check on each job.
  let lastInRampUp = isInRampUp();
  const checkRampUpTransition = (): void => {
    const now = isInRampUp();
    if (now !== lastInRampUp) {
      logger.info({ inRampUp: now }, "ramp-up boundary crossed; resetting buckets");
      buckets.clear();
      lastInRampUp = now;
    }
  };
  const conversationGap = new ConversationGap(undefined, env.OUTBOUND_MIN_GAP_MS);
  const sendLock = new ConversationSendLock();

  const w = outboundWorker(async (job: OutboundJob, token) => {
    checkRampUpTransition();
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
      // Account-level cooldown (set when we hit a 429). If active, delay
      // this job until the cooldown clears. ALL pending jobs for this
      // account stack up here instead of each one trying to send and
      // burning a retry budget on the same rate-limit window.
      const acctCooldown = await getAccountCooldownMs(data.accountId);
      if (acctCooldown > 0) {
        logger.debug({ ...ctx, cooldownMs: acctCooldown }, "account in 429 cooldown; delaying");
        await job.moveToDelayed(Date.now() + acctCooldown, token);
        throw new DelayedError();
      }

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
        } else if (data.kind === "preview" && data.preview) {
          // Free media post: same OFAPI endpoint as PPV, just price=0. The
          // platform infers PPV-vs-free from `price > 0`, so a 0-priced media
          // attachment lands as a regular DM photo/clip the fan sees inline.
          result = await deps.adapter.sendPPV(adapterCtx, {
            subscriberExternalId: data.subscriberExternalId,
            assetRef: data.preview.mediaRef,
            priceCents: 0,
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
        // 401 / 403: bad/revoked token won't fix itself — drop permanently.
        if (err instanceof PlatformHttpError && (err.status === 401 || err.status === 403)) {
          throw new UnrecoverableError(err.message);
        }
        // 429: trigger an account-wide cooldown so OTHER queued jobs stop
        // hammering OF too. Then delay THIS job until the cooldown clears
        // and try once more. Stale messages (>15 min) get dropped.
        if (err instanceof PlatformHttpError && err.status === 429) {
          const ageMs = Date.now() - job.timestamp;
          const STALE_AFTER_MS = 15 * 60_000;
          if (ageMs > STALE_AFTER_MS) {
            logger.warn({ ...ctx, ageMs }, "send 429 — message too stale, dropping");
            throw new UnrecoverableError(
              `message too stale after repeated 429s (age=${Math.round(ageMs / 1000)}s)`,
            );
          }
          await setAccountCooldown(data.accountId);
          logger.warn(
            { ...ctx, ageMs, cooldownMs: ACCOUNT_COOLDOWN_MS },
            "send 429 — account-wide cooldown triggered; delaying this job",
          );
          await job.moveToDelayed(Date.now() + ACCOUNT_COOLDOWN_MS, token);
          throw new DelayedError();
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
