import { logger } from "../observability/logger.js";
import {
  claimDueSends,
  countRemainingSends,
  loadCampaign,
  markSendFailed,
  setCampaignStatus,
} from "../db/repos/campaigns.js";
import { ensureConversation } from "../db/repos/conversations.js";
import { loadLatestArchetype } from "../db/repos/archetypes.js";
import { loadCurrentFacts } from "../db/repos/subscriber_facts.js";
import { loadSubscriberExternalId } from "../db/repos/subscribers.js";
import { loadConversationState } from "../db/repos/conversations.js";
import { renderArchetypeDirective } from "../prompt/layers/archetype.js";
import { pickRelevantFacts } from "../prompt/layers/facts.js";
import { loadCatalogItem } from "../db/repos/ppv_catalog.js";
import { withConversationLock } from "../queue/locks.js";
import { generateReply } from "./replyPipeline.js";
import type { CampaignRow } from "../db/repos/campaigns.js";
import type { PpvCatalogRow } from "../db/repos/ppv_catalog.js";

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 25;

export interface BroadcastRunnerHandle {
  stop(): Promise<void>;
}

/**
 * Periodically sweep active campaigns and enqueue due sends. Each claimed send
 * runs through the normal reply pipeline (broadcast mode), so humanness,
 * prompt layers, and outbound rate limits apply — broadcasts are just
 * "inbound-less turns", not a parallel track.
 */
export function startBroadcastRunner(): BroadcastRunnerHandle {
  let stopped = false;
  let activeTimer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await sweepOnce();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "broadcast sweep failed",
      );
    } finally {
      if (!stopped) {
        activeTimer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
  };

  activeTimer = setTimeout(tick, POLL_INTERVAL_MS);
  logger.info("broadcast runner started");

  return {
    async stop() {
      stopped = true;
      if (activeTimer) clearTimeout(activeTimer);
    },
  };
}

/**
 * Look for campaigns whose due sends are ready, claim a batch, and enqueue
 * each one. Exposed for tests and for a one-shot cron path if operators want
 * to run this out-of-process.
 */
export async function sweepOnce(): Promise<void> {
  // Broadcast sweeps are cheap — polling campaign_sends directly is fine.
  // When volume grows, swap this for a per-campaign BullMQ scheduled job.
  const now = new Date();
  // Naive: look up campaigns in "running" or "queued" state. Scales with
  // campaign count, not subscriber count, so a table scan here is ok.
  const campaignIds = await listActiveCampaignIds();
  for (const campaignId of campaignIds) {
    await processCampaignBatch(campaignId, now);
  }
}

async function listActiveCampaignIds(): Promise<string[]> {
  // Small query — kept inline to avoid a dedicated repo fn for one caller.
  const { db } = await import("../db/client.js");
  const rows = await db
    .selectFrom("v3.campaigns")
    .select("id")
    .where("status", "in", ["queued", "running"])
    .execute();
  return rows.map((r) => r.id);
}

async function processCampaignBatch(campaignId: string, now: Date): Promise<void> {
  const campaign = await loadCampaign(campaignId);
  if (!campaign) return;
  if (campaign.status === "paused" || campaign.status === "cancelled") return;

  const due = await claimDueSends({ campaignId, limit: BATCH_SIZE, now });
  if (due.length === 0) {
    const remaining = await countRemainingSends(campaignId);
    if (remaining === 0 && campaign.status !== "done") {
      await setCampaignStatus(campaignId, "done");
      logger.info({ campaignId }, "campaign done");
    }
    return;
  }

  if (campaign.status === "queued") {
    await setCampaignStatus(campaignId, "running");
  }

  // Pre-fetch the PPV asset once if the template references one.
  let asset: PpvCatalogRow | null = null;
  if (campaign.template.assetId) {
    asset = await loadCatalogItem(campaign.template.assetId);
    if (!asset) {
      logger.warn(
        { campaignId, assetId: campaign.template.assetId },
        "campaign asset missing; sending without attachment",
      );
    }
  }

  await Promise.all(
    due.map((send) =>
      runBroadcastSend(campaign, send.id, send.subscriberId, asset).catch((err) =>
        handleSendFailure(send.id, err),
      ),
    ),
  );
}

async function runBroadcastSend(
  campaign: CampaignRow,
  sendId: string,
  subscriberId: string,
  asset: PpvCatalogRow | null,
): Promise<void> {
  const externalId = await loadSubscriberExternalId(subscriberId);
  if (!externalId) {
    logger.warn({ sendId, subscriberId }, "broadcast send missing external id; skipping");
    await markSendFailed(sendId, "subscriber external_id missing");
    return;
  }

  const { id: conversationId } = await ensureConversation({
    subscriberId,
    accountId: campaign.accountId,
  });

  await withConversationLock(conversationId, async () => {
    const [convo, archetype, facts] = await Promise.all([
      loadConversationState(conversationId),
      loadLatestArchetype(subscriberId),
      loadCurrentFacts(subscriberId, 30),
    ]);
    if (!convo) {
      logger.warn({ conversationId }, "broadcast: missing conversation state");
      return;
    }

    const archetypeDirective = archetype ? renderArchetypeDirective(archetype) : undefined;
    // Without an inbound to score against, use the template prompt as the scoring text.
    const factStrings = pickRelevantFacts({
      facts,
      inboundText: campaign.template.prompt,
      k: 5,
    });

    const pitch =
      asset != null
        ? {
            asset,
            priceCents:
              campaign.template.priceOverrideCents ??
              Math.round((asset.priceFloorCents + asset.priceCeilingCents) / 2),
          }
        : undefined;

    const objective = [
      campaign.template.prompt,
      campaign.template.tone ? `Tone: ${campaign.template.tone}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    await generateReply({
      accountId: campaign.accountId,
      conversationId,
      subscriberId,
      subscriberExternalId: externalId,
      incomingText: "",
      turnIndex: 0,
      phase: convo.phase,
      broadcastObjective: objective,
      archetype,
      ...(archetypeDirective !== undefined ? { archetypeDirective } : {}),
      ...(factStrings.length > 0 ? { facts: factStrings } : {}),
      ...(pitch ? { pitch } : {}),
    });

    logger.info({ sendId, campaignId: campaign.id, conversationId }, "broadcast send enqueued");
  });
}

async function handleSendFailure(sendId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ sendId, err: message }, "broadcast send failed");
  await markSendFailed(sendId, message);
}
