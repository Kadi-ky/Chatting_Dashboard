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
 *
 * Duration is dynamic now (per OFAPI guidance 2026-04-28): use the
 * Retry-After header from the 429 response. Falls back to exponential
 * backoff when no header is present (1s → 2s → 4s → 8s, capped at 60s).
 */
const ACCOUNT_COOLDOWN_KEY = (accountId: string): string => `acct_cooldown:${accountId}`;
/** Cap for exponential-backoff fallback when Retry-After is absent. */
const COOLDOWN_FALLBACK_CAP_MS = 60_000;
/** Hard ceiling we never exceed even if the server says wait longer (5 min). */
const COOLDOWN_HARD_CAP_MS = 5 * 60_000;

async function getAccountCooldownMs(accountId: string): Promise<number> {
  const ttl = await sharedRedis().pttl(ACCOUNT_COOLDOWN_KEY(accountId));
  return ttl > 0 ? ttl : 0;
}

async function setAccountCooldown(accountId: string, durationMs: number): Promise<void> {
  const clamped = Math.min(Math.max(durationMs, 1000), COOLDOWN_HARD_CAP_MS);
  await sharedRedis().set(ACCOUNT_COOLDOWN_KEY(accountId), "1", "PX", clamped);
}

/**
 * Compute the cooldown duration for a 429.
 *   - If Retry-After header was returned, honor it (clamped to hard cap).
 *   - Otherwise exponential backoff per BullMQ attempt: 1s, 2s, 4s, 8s,
 *     capped at COOLDOWN_FALLBACK_CAP_MS.
 *
 * OFAPI explicitly warned: retrying SOONER than Retry-After triggers
 * stricter back-off — never go below the header value.
 */
function compute429CooldownMs(err: PlatformHttpError, attempt: number): { ms: number; source: "retry-after" | "expo" } {
  if (err.retryAfterMs && err.retryAfterMs > 0) {
    return { ms: err.retryAfterMs, source: "retry-after" };
  }
  // BullMQ's `attempt` is 1-indexed for the next retry. Map to 0-indexed
  // exponent: 1s, 2s, 4s, 8s, 16s, 32s, 60s (cap).
  const expo = 1000 * Math.pow(2, Math.max(0, attempt - 1));
  return { ms: Math.min(expo, COOLDOWN_FALLBACK_CAP_MS), source: "expo" };
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

      // Fire "Model is typing..." indicator for ~4s. Free OF endpoint, covers
      // the actual API-call latency so the message doesn't appear out of
      // nowhere. Fire-and-forget (adapter swallows its own errors); we do
      // NOT await it because the API call itself is the next thing we do
      // and the indicator should overlap with it. Adapter.sendTypingIndicator
      // is contract-bound to never throw, so .catch() is belt-and-suspenders.
      void deps.adapter.sendTypingIndicator(adapterCtx, data.subscriberExternalId).catch(() => {});

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
          // Free media post — sendFreeMedia OMITS the price field entirely
          // (sending price=0 caused OFAPI to reject as malformed PPV / render
          // a $0 paywalled bubble). The n8n flow proves text + mediaFiles
          // (no price) lands as an in-DM photo/clip the fan sees inline.
          result = await deps.adapter.sendFreeMedia(adapterCtx, {
            subscriberExternalId: data.subscriberExternalId,
            mediaRef: data.preview.mediaRef,
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
        // Dead-fan + content-filter classes — non-retryable. Pre-fix these
        // burned 3 BullMQ retry attempts per occurrence (~210 wasted OFAPI
        // credits/day per dead-fan audit 2026-05-27). The dead-fan flag is
        // already set by the adapter; subsequent workers will skip. The
        // content-filter case (e.g. "incest" word in a refusal) won't
        // succeed on retry either — the bot output is the problem, not
        // the network.
        if (err instanceof PlatformHttpError && err.status === 400) {
          const body = err.body ?? "";
          if (
            body.includes("Cannot send message to this user") ||
            body.includes("Cannot send message to yourself") ||
            body.includes("Input contains restricted words")
          ) {
            throw new UnrecoverableError(`non-retryable 400: ${body.slice(0, 120)}`);
          }
        }
        if (err instanceof PlatformHttpError && err.status === 404) {
          throw new UnrecoverableError(`non-retryable 404 (user not found)`);
        }
        // 429: honor OFAPI's Retry-After guidance.
        //   - Use Retry-After header value if present (server tells us exactly
        //     when to retry; retrying sooner triggers stricter back-off).
        //   - Otherwise exponential backoff (1s → 2s → 4s → 8s, cap 60s).
        // Trigger an account-wide cooldown so OTHER queued jobs for the same
        // account stop hammering OF in the meantime. Stale messages (>15 min
        // old) get dropped.
        if (err instanceof PlatformHttpError && err.status === 429) {
          const ageMs = Date.now() - job.timestamp;
          const STALE_AFTER_MS = 15 * 60_000;
          if (ageMs > STALE_AFTER_MS) {
            logger.warn({ ...ctx, ageMs }, "send 429 — message too stale, dropping");
            throw new UnrecoverableError(
              `message too stale after repeated 429s (age=${Math.round(ageMs / 1000)}s)`,
            );
          }
          const { ms: cooldownMs, source } = compute429CooldownMs(err, job.attemptsMade);
          await setAccountCooldown(data.accountId, cooldownMs);
          logger.warn(
            { ...ctx, ageMs, cooldownMs, source, retryAfterMs: err.retryAfterMs ?? null, attempt: job.attemptsMade },
            "send 429 — delaying job per Retry-After / expo backoff",
          );
          await job.moveToDelayed(Date.now() + cooldownMs, token);
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
