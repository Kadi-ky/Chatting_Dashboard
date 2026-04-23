import { sql, type SqlBool } from "kysely";
import { db } from "../client.js";
import type {
  EngagementLevel,
  PriceSensitivity,
  RelationshipTone,
  SpenderTier,
} from "../types.js";
import type { ArchetypeOutput } from "../../archetype/schema.js";

export interface LatestArchetypeRow {
  id: string;
  subscriberId: string;
  classifiedAt: Date;
  classifierVersion: string;
  spenderTier: SpenderTier;
  confidence: number;
  fetishTags: string[];
  engagementLevel: EngagementLevel;
  relationshipTone: RelationshipTone;
  priceSensitivity: PriceSensitivity;
  objectionPatterns: string[];
  timezoneHint: string | null;
  pivotSignals: string[];
}

export async function insertArchetype(args: {
  subscriberId: string;
  classifierVersion: string;
  output: ArchetypeOutput;
  raw?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const o = args.output;
  const row = await db
    .insertInto("v3.archetypes")
    .values({
      subscriber_id: args.subscriberId,
      classifier_version: args.classifierVersion,
      spender_tier: o.spenderTier,
      confidence: String(o.confidence),
      fetish_tags: o.fetishTags,
      engagement_level: o.engagementLevel,
      relationship_tone: o.relationshipTone,
      price_sensitivity: o.priceSensitivity,
      objection_patterns: o.objectionPatterns,
      timezone_hint: o.timeZoneHint,
      pivot_signals: o.pivotSignals,
      ...(args.raw ? { raw: JSON.stringify(args.raw) } : {}),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export async function loadLatestArchetype(
  subscriberId: string,
): Promise<LatestArchetypeRow | null> {
  const row = await db
    .selectFrom("v3.archetypes")
    .select([
      "id",
      "subscriber_id",
      "classified_at",
      "classifier_version",
      "spender_tier",
      "confidence",
      "fetish_tags",
      "engagement_level",
      "relationship_tone",
      "price_sensitivity",
      "objection_patterns",
      "timezone_hint",
      "pivot_signals",
    ])
    .where("subscriber_id", "=", subscriberId)
    .orderBy("classified_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    subscriberId: row.subscriber_id,
    classifiedAt: row.classified_at as unknown as Date,
    classifierVersion: row.classifier_version,
    spenderTier: row.spender_tier,
    confidence: Number(row.confidence),
    fetishTags: row.fetish_tags,
    engagementLevel: row.engagement_level,
    relationshipTone: row.relationship_tone,
    priceSensitivity: row.price_sensitivity,
    objectionPatterns: row.objection_patterns,
    timezoneHint: row.timezone_hint,
    pivotSignals: row.pivot_signals,
  };
}

/** Count how many inbound messages have arrived since the latest archetype was classified. */
export async function countInboundSinceLastArchetype(subscriberId: string): Promise<number> {
  const latest = await db
    .selectFrom("v3.archetypes")
    .select("classified_at")
    .where("subscriber_id", "=", subscriberId)
    .orderBy("classified_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const cutoff = latest ? (latest.classified_at as unknown as Date) : null;
  const row = await db
    .selectFrom("v3.messages")
    .innerJoin("v3.conversations", "v3.conversations.id", "v3.messages.conversation_id")
    .select(db.fn.count<string>("v3.messages.id").as("count"))
    .where("v3.conversations.subscriber_id", "=", subscriberId)
    .where("v3.messages.direction", "=", "inbound")
    .$if(cutoff != null, (qb) =>
      qb.where(sql<SqlBool>`v3.messages.created_at > ${cutoff}`),
    )
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}
