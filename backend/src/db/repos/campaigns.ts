import { sql } from "kysely";
import { db } from "../client.js";
import type { CampaignStatus, CampaignSendStatus } from "../types.js";
import type {
  SegmentQuery,
  CampaignTemplate,
  SendWindow,
  RateCap,
} from "../../broadcast/types.js";

export interface CampaignRow {
  id: string;
  accountId: string;
  name: string;
  segmentQuery: SegmentQuery;
  template: CampaignTemplate;
  sendWindow: SendWindow;
  rateCap: RateCap;
  status: CampaignStatus;
  createdAt: Date;
}

export async function createCampaign(args: {
  accountId: string;
  name: string;
  segment: SegmentQuery;
  template: CampaignTemplate;
  window: SendWindow;
  rateCap: RateCap;
}): Promise<{ id: string }> {
  const row = await db
    .insertInto("v3.campaigns")
    .values({
      account_id: args.accountId,
      name: args.name,
      segment_query: JSON.stringify(args.segment),
      template: JSON.stringify(args.template),
      send_window: JSON.stringify(args.window),
      rate_cap: JSON.stringify(args.rateCap),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export async function loadCampaign(id: string): Promise<CampaignRow | null> {
  const row = await db
    .selectFrom("v3.campaigns")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    segmentQuery: row.segment_query as unknown as SegmentQuery,
    template: row.template as unknown as CampaignTemplate,
    sendWindow: row.send_window as unknown as SendWindow,
    rateCap: row.rate_cap as unknown as RateCap,
    status: row.status,
    createdAt: row.created_at as unknown as Date,
  };
}

export async function setCampaignStatus(id: string, status: CampaignStatus): Promise<void> {
  await db
    .updateTable("v3.campaigns")
    .set({ status, updated_at: sql`now()` })
    .where("id", "=", id)
    .execute();
}

// ─── campaign_sends ─────────────────────────────────────────────────────────

export interface CampaignSendRow {
  id: string;
  campaignId: string;
  subscriberId: string;
  scheduledAt: Date;
  sentAt: Date | null;
  status: CampaignSendStatus;
  error: string | null;
}

export async function insertCampaignSends(args: {
  campaignId: string;
  schedule: Array<{ subscriberId: string; scheduledAt: Date }>;
}): Promise<number> {
  if (args.schedule.length === 0) return 0;
  const rows = args.schedule.map((s) => ({
    campaign_id: args.campaignId,
    subscriber_id: s.subscriberId,
    scheduled_at: s.scheduledAt,
  }));
  const result = await db.insertInto("v3.campaign_sends").values(rows).executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}

export async function claimDueSends(args: {
  campaignId: string;
  limit: number;
  now: Date;
}): Promise<CampaignSendRow[]> {
  // Claim-and-mark-running atomically so a second scheduler tick doesn't
  // re-pick the same rows. FOR UPDATE SKIP LOCKED inside the subquery + the
  // surrounding UPDATE run in one statement — safe under concurrency.
  const rows = await db
    .updateTable("v3.campaign_sends")
    .set({ status: "sent", sent_at: sql`now()` })
    .where(
      "id",
      "in",
      sql<string>`(
        select id from v3.campaign_sends
         where campaign_id = ${args.campaignId}
           and status = 'scheduled'
           and scheduled_at <= ${args.now}
         order by scheduled_at asc
         limit ${args.limit}
         for update skip locked
      )`,
    )
    .returning(["id", "campaign_id", "subscriber_id", "scheduled_at", "sent_at", "status", "error"])
    .execute();

  return rows.map((r) => ({
    id: r.id,
    campaignId: r.campaign_id,
    subscriberId: r.subscriber_id,
    scheduledAt: r.scheduled_at as unknown as Date,
    sentAt: (r.sent_at as unknown as Date | null) ?? null,
    status: r.status,
    error: r.error,
  }));
}

export async function markSendFailed(id: string, error: string): Promise<void> {
  await db
    .updateTable("v3.campaign_sends")
    .set({ status: "failed", error })
    .where("id", "=", id)
    .execute();
}

export async function countRemainingSends(campaignId: string): Promise<number> {
  const row = await db
    .selectFrom("v3.campaign_sends")
    .select(db.fn.count<string>("id").as("count"))
    .where("campaign_id", "=", campaignId)
    .where("status", "=", "scheduled")
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}
