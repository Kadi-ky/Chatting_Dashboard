import { sql } from "kysely";
import { db } from "../client.js";

export interface AccountRow {
  id: string;
  name: string;
  personaVersion: string;
  status: string;
  platform: string;
  platformAccountId: string | null;
  creatorUuid: string | null;
  config: Record<string, unknown>;
}

function mapRow(row: {
  id: string;
  name: string;
  persona_version: string;
  status: string;
  platform: string;
  platform_account_id: string | null;
  creator_uuid: string | null;
  config: Record<string, unknown>;
}): AccountRow {
  return {
    id: row.id,
    name: row.name,
    personaVersion: row.persona_version,
    status: row.status,
    platform: row.platform,
    platformAccountId: row.platform_account_id,
    creatorUuid: row.creator_uuid,
    config: row.config,
  };
}

export async function loadAccountById(id: string): Promise<AccountRow | null> {
  const row = await db
    .selectFrom("v3.accounts")
    .select([
      "id",
      "name",
      "persona_version",
      "status",
      "platform",
      "platform_account_id",
      "creator_uuid",
      "config",
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? mapRow(row) : null;
}

/**
 * Look up an internal account by the upstream platform's id. Webhook ingress
 * relies on this to route payloads to the right tenant.
 */
export async function loadAccountByPlatformId(
  platform: string,
  platformAccountId: string,
): Promise<AccountRow | null> {
  const row = await db
    .selectFrom("v3.accounts")
    .select([
      "id",
      "name",
      "persona_version",
      "status",
      "platform",
      "platform_account_id",
      "creator_uuid",
      "config",
    ])
    .where("platform", "=", platform)
    .where("platform_account_id", "=", platformAccountId)
    .executeTakeFirst();
  return row ? mapRow(row) : null;
}

export async function loadAccountByCreatorUuid(creatorUuid: string): Promise<AccountRow | null> {
  const row = await db
    .selectFrom("v3.accounts")
    .select([
      "id",
      "name",
      "persona_version",
      "status",
      "platform",
      "platform_account_id",
      "creator_uuid",
      "config",
    ])
    .where("creator_uuid", "=", creatorUuid)
    .executeTakeFirst();
  return row ? mapRow(row) : null;
}

/**
 * Insert-or-fetch by (platform, platform_account_id). Used by the webhook
 * ingress in SHADOW_MODE so that real production traffic for any creator can
 * land without manual provisioning. The row is marked status='active' with
 * the platform_account_id mirrored into creator_uuid (OFAPI uses the same
 * value on both sides). Idempotent — a second call with the same id returns
 * the existing row.
 */
export async function upsertShadowAccount(args: {
  platform: string;
  platformAccountId: string;
  name?: string;
}): Promise<AccountRow> {
  const existing = await loadAccountByPlatformId(args.platform, args.platformAccountId);
  if (existing) return existing;

  const inserted = await db
    .insertInto("v3.accounts")
    .values({
      name: args.name ?? `shadow:${args.platformAccountId}`,
      persona_version: "v1",
      status: "active",
      platform: args.platform,
      platform_account_id: args.platformAccountId,
      creator_uuid: args.platformAccountId,
      config: sql`'{"shadow":true}'::jsonb`,
    })
    .returning([
      "id",
      "name",
      "persona_version",
      "status",
      "platform",
      "platform_account_id",
      "creator_uuid",
      "config",
    ])
    .executeTakeFirstOrThrow();
  return mapRow(inserted);
}

/** All accounts the workers should be servicing. Polled each tick. */
export async function listActiveAccounts(): Promise<AccountRow[]> {
  const rows = await db
    .selectFrom("v3.accounts")
    .select([
      "id",
      "name",
      "persona_version",
      "status",
      "platform",
      "platform_account_id",
      "creator_uuid",
      "config",
    ])
    .where("status", "=", "active")
    .execute();
  return rows.map(mapRow);
}
