import { logger } from "../observability/logger.js";
import { resolveSegment } from "./segmenter.js";
import {
  createCampaign,
  loadCampaign,
  setCampaignStatus,
  insertCampaignSends,
} from "../db/repos/campaigns.js";
import type { CampaignConfig, RateCap, SendWindow } from "./types.js";

/**
 * Plan a campaign: resolve segment, compute per-recipient schedule respecting
 * the window and rate cap, write campaign + campaign_sends rows. Returns the
 * campaign id and the count of scheduled sends.
 */
export async function planCampaign(
  cfg: CampaignConfig,
): Promise<{ campaignId: string; scheduled: number }> {
  const segment = await resolveSegment(cfg.accountId, cfg.segment);
  if (segment.length === 0) {
    logger.warn({ accountId: cfg.accountId, name: cfg.name }, "campaign segment empty");
    const empty = await createCampaign({
      accountId: cfg.accountId,
      name: cfg.name,
      segment: cfg.segment,
      template: cfg.template,
      window: cfg.window,
      rateCap: cfg.rateCap,
    });
    await setCampaignStatus(empty.id, "done");
    return { campaignId: empty.id, scheduled: 0 };
  }

  const schedule = distributeOverWindow({
    recipients: segment.map((s) => s.subscriberId),
    window: cfg.window,
    rateCap: cfg.rateCap,
  });

  const { id: campaignId } = await createCampaign({
    accountId: cfg.accountId,
    name: cfg.name,
    segment: cfg.segment,
    template: cfg.template,
    window: cfg.window,
    rateCap: cfg.rateCap,
  });

  const scheduled = await insertCampaignSends({ campaignId, schedule });
  await setCampaignStatus(campaignId, "queued");

  logger.info(
    { campaignId, accountId: cfg.accountId, scheduled, total: segment.length },
    "campaign planned",
  );
  return { campaignId, scheduled };
}

/**
 * Spread recipients across [start, end] at a cadence compatible with rateCap.
 * Caller's responsible for ensuring start < end; window in wall time.
 */
export function distributeOverWindow(args: {
  recipients: string[];
  window: SendWindow;
  rateCap: RateCap;
}): Array<{ subscriberId: string; scheduledAt: Date }> {
  const { recipients, window, rateCap } = args;
  const start = new Date(window.start).getTime();
  const end = new Date(window.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("invalid send window");
  }
  const windowMs = end - start;

  // Gap dictated by whichever cap is tighter.
  const gapFromMinute = rateCap.perMinute > 0 ? 60_000 / rateCap.perMinute : 0;
  const gapFromHour = rateCap.perHour > 0 ? 3_600_000 / rateCap.perHour : 0;
  const minGap = Math.max(gapFromMinute, gapFromHour, 500);

  // Even distribution across the window. If rate cap is the binding constraint,
  // span may exceed window — callers should size the window to fit.
  const evenGap = recipients.length > 1 ? windowMs / (recipients.length - 1) : 0;
  const gap = Math.max(minGap, evenGap);

  return recipients.map((subscriberId, i) => ({
    subscriberId,
    scheduledAt: new Date(start + i * gap),
  }));
}

/** Convenience wrapper: ticks a single campaign (used by the scheduler worker). */
export async function touchCampaign(campaignId: string): Promise<void> {
  const campaign = await loadCampaign(campaignId);
  if (!campaign) return;
  if (campaign.status === "queued") {
    await setCampaignStatus(campaignId, "running");
  }
}
