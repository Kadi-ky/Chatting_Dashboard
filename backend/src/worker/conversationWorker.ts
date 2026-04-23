import type { Worker } from "bullmq";
import { logger } from "../observability/logger.js";
import { deserializeEvent, inboundWorker, type InboundJobData } from "../queue/inbound.js";
import { recordEvent, markEventProcessed } from "../db/repos/events.js";
import { upsertSubscriber, markLastInbound } from "../db/repos/subscribers.js";
import { ensureConversation, touchConversation } from "../db/repos/conversations.js";
import { insertMessage } from "../db/repos/messages.js";
import { markMostRecentAttemptUnlocked } from "../db/repos/ppv_attempts.js";
import { incrementUnlockCounter, loadCatalogItem } from "../db/repos/ppv_catalog.js";
import { bumpUnlock } from "../db/repos/asset_performance.js";
import { recordPurchase, parseLegacySourceRef } from "../db/repos/purchases.js";
import { recordTransaction } from "../db/repos/transactions.js";
import { loadLatestArchetype } from "../db/repos/archetypes.js";
import { archetypeSlice } from "../ppv/ranker.js";
import { pickPacingVariant } from "../humanness/pacing.js";
import { metrics } from "../observability/metrics.js";
import { turnQueue } from "../queue/turns.js";
import { env } from "../config/index.js";
import type { PlatformEvent } from "../platform/PlatformAdapter.js";

/**
 * Inbound worker. Responsibilities:
 *   - Idempotent event recording (dedup by external_id).
 *   - Materialise message rows for message.received.
 *   - Schedule a DEBOUNCED per-conversation turn job so rapid-fire messages
 *     coalesce into a single reply — the turn worker does the heavy lifting.
 *   - Handle non-message events (unlock / tip) inline.
 */
export function startConversationWorker(): Worker<InboundJobData> {
  const w = inboundWorker(async (job) => {
    const { accountId, event: serialized } = job.data;
    const event = deserializeEvent(serialized);
    await handleEvent(accountId, event);
  });

  w.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "inbound job failed");
  });
  w.on("completed", (job) => {
    logger.debug({ jobId: job.id }, "inbound job ok");
  });

  logger.info("conversation worker started");
  return w;
}

async function handleEvent(accountId: string, event: PlatformEvent): Promise<void> {
  const ctx = { kind: event.kind, externalId: event.externalId };
  metrics.inboundEventsTotal.inc();

  const { inserted, id: eventRowId } = await recordEvent(accountId, event);
  if (!inserted) {
    logger.debug(ctx, "duplicate event — skipping");
    return;
  }

  if (event.kind === "message.received") {
    await handleMessageReceived(accountId, event);
  } else if (event.kind === "ppv.unlocked") {
    await handlePpvUnlocked(accountId, event);
  } else if (event.kind === "tip.received") {
    await handleTipReceived(accountId, event);
  } else {
    logger.info(ctx, "non-message event recorded; no handler yet");
  }

  await markEventProcessed(eventRowId);
}

async function handleMessageReceived(
  accountId: string,
  event: PlatformEvent,
): Promise<void> {
  const text = typeof event.payload.text === "string" ? (event.payload.text as string) : null;
  const attachments = Array.isArray(event.payload.attachments)
    ? (event.payload.attachments as unknown[])
    : [];

  const { id: subscriberId } = await upsertSubscriber({
    accountId,
    externalId: event.subscriberExternalId,
  });

  const { id: conversationId } = await ensureConversation({ subscriberId, accountId });

  const msg = await insertMessage({
    conversationId,
    direction: "inbound",
    kind: "text",
    text,
    attachments,
    externalId: event.externalId,
  });

  await Promise.all([
    markLastInbound(subscriberId, event.occurredAt),
    touchConversation(conversationId),
  ]);

  logger.info(
    { externalId: event.externalId, subscriberId, conversationId, inserted: msg !== null },
    "message received",
  );

  if (msg === null) return;
  if (!text || text.trim().length === 0) return;

  // Debounced turn enqueue. BullMQ dedupes on jobId, so N rapid-fire messages
  // for the same conversation collapse to one turn job. The delay gives the
  // fan time to finish typing — the turn worker reads all unreplied inbound
  // at fire time and responds to the whole burst.
  await turnQueue().add(
    "turn",
    {
      accountId,
      conversationId,
      subscriberId,
      subscriberExternalId: event.subscriberExternalId,
    },
    { jobId: `turn-${conversationId}`, delay: env.BURST_WINDOW_MS },
  );
}

async function handlePpvUnlocked(accountId: string, event: PlatformEvent): Promise<void> {
  const { id: subscriberId } = await upsertSubscriber({
    accountId,
    externalId: event.subscriberExternalId,
  });
  const { id: conversationId } = await ensureConversation({ subscriberId, accountId });

  const priceCents =
    typeof event.payload.price_cents === "number"
      ? (event.payload.price_cents as number)
      : typeof event.payload.amount_cents === "number"
        ? (event.payload.amount_cents as number)
        : 0;
  const assetRef =
    typeof event.payload.asset_ref === "string" ? (event.payload.asset_ref as string) : null;

  const attempt = await markMostRecentAttemptUnlocked({
    conversationId,
    unlockedAt: event.occurredAt,
  });

  await recordTransaction({
    subscriberId,
    kind: "ppv_unlock",
    amountCents: priceCents,
    occurredAt: event.occurredAt,
    externalId: event.externalId,
    metadata: { assetRef, attemptId: attempt?.id ?? null },
  });

  if (attempt) {
    const archetype = await loadLatestArchetype(subscriberId);
    await Promise.all([
      incrementUnlockCounter(attempt.assetId, priceCents),
      bumpUnlock(attempt.assetId, archetypeSlice(archetype), priceCents),
    ]);

    // Mirror the unlock into the legacy purchases_onlyfans table so the
    // script picker on the fan's next turn sees the ladder advance. Safe to
    // skip if the attempt was against a non-legacy asset (no source_ref).
    const catalog = await loadCatalogItem(attempt.assetId);
    const parsed = parseLegacySourceRef(catalog?.sourceRef ?? null);
    if (parsed) {
      await recordPurchase({
        fanUuid: event.subscriberExternalId,
        creatorUuid: parsed.creatorUuid,
        scriptNumber: parsed.scriptNumber,
        rung: parsed.rung,
        amountCents: priceCents,
        purchasedAt: event.occurredAt,
      });
    }
  }
  const pacingBucket = pickPacingVariant(conversationId).id;
  metrics.ppvUnlocked.inc(1, { pacing: pacingBucket });
  metrics.ppvRevenueCents.inc(priceCents, { pacing: pacingBucket });

  logger.info(
    { conversationId, subscriberId, priceCents, attemptId: attempt?.id ?? null },
    "ppv unlocked",
  );
}

async function handleTipReceived(accountId: string, event: PlatformEvent): Promise<void> {
  const { id: subscriberId } = await upsertSubscriber({
    accountId,
    externalId: event.subscriberExternalId,
  });
  const amountCents =
    typeof event.payload.amount_cents === "number" ? (event.payload.amount_cents as number) : 0;
  await recordTransaction({
    subscriberId,
    kind: "tip",
    amountCents,
    occurredAt: event.occurredAt,
    externalId: event.externalId,
  });
  logger.info({ subscriberId, amountCents }, "tip recorded");
}
