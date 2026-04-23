import { sql, type SqlBool } from "kysely";
import { db } from "../db/client.js";
import type { SegmentQuery } from "./types.js";

export interface SegmentMember {
  subscriberId: string;
  lastInboundAt: Date | null;
}

/**
 * Resolve a SegmentQuery to a list of subscriber ids (ordered most-recent
 * first). Joins the latest archetype per subscriber. Unknown archetype rows
 * are filtered out when archetype-based clauses are present.
 */
export async function resolveSegment(
  accountId: string,
  segment: SegmentQuery,
): Promise<SegmentMember[]> {
  const wantsArchetype =
    segment.spenderTier !== undefined ||
    segment.engagementLevel !== undefined ||
    segment.anyFetishTag !== undefined;
  const wantsPhase = segment.phase !== undefined;

  let q = db
    .selectFrom("v3.subscribers as s")
    .select(["s.id as id", "s.last_inbound_at as last_inbound_at"])
    .where("s.account_id", "=", accountId);

  if (segment.active !== false) {
    q = q.where("s.is_active", "=", true);
  }

  if (segment.silentAtLeastDays != null) {
    const cutoff = new Date(Date.now() - segment.silentAtLeastDays * 86_400_000);
    q = q.where(sql<SqlBool>`(s.last_inbound_at is null or s.last_inbound_at < ${cutoff})`);
  }

  if (segment.excludeActiveWithinHours != null) {
    const cutoff = new Date(Date.now() - segment.excludeActiveWithinHours * 3_600_000);
    q = q.where(sql<SqlBool>`(s.last_inbound_at is null or s.last_inbound_at < ${cutoff})`);
  }

  if (wantsArchetype) {
    const tiers = toArray(segment.spenderTier);
    const engagement = toArray(segment.engagementLevel);
    const fetishTags = segment.anyFetishTag ?? [];

    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("v3.archetypes as a")
          .select("a.id")
          .whereRef("a.subscriber_id", "=", "s.id")
          .where(sql<SqlBool>`a.classified_at = (
            select max(a2.classified_at) from v3.archetypes a2 where a2.subscriber_id = s.id
          )`)
          .$if(tiers.length > 0, (qb) => qb.where("a.spender_tier", "in", tiers))
          .$if(engagement.length > 0, (qb) => qb.where("a.engagement_level", "in", engagement))
          .$if(fetishTags.length > 0, (qb) =>
            qb.where(sql<SqlBool>`a.fetish_tags && ${fetishTags}::text[]`),
          ),
      ),
    );
  }

  if (wantsPhase) {
    const phases = toArray(segment.phase);
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("v3.conversations as c")
          .select("c.id")
          .whereRef("c.subscriber_id", "=", "s.id")
          .where("c.phase", "in", phases),
      ),
    );
  }

  q = q.orderBy("s.last_inbound_at", sql`desc nulls last`);

  if (segment.limit != null) {
    q = q.limit(segment.limit);
  }

  const rows = await q.execute();
  return rows.map((r) => ({
    subscriberId: r.id,
    lastInboundAt: (r.last_inbound_at as unknown as Date | null) ?? null,
  }));
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
