import { db } from "../client.js";

/**
 * A "script" in the legacy content inventory is a 4-rung narrative arc.
 * Each row bundles a preview plus 4 PPVs with per-rung prices and descriptions.
 * The V3 script picker treats `(scriptId, rung)` as one pickable asset.
 */
export interface ContentScript {
  id: string;
  scriptNumber: number;
  scriptName: string | null;
  creatorUuid: string | null;
  creatorName: string | null;
  tagCreator: string | null;
  tags: string[];
  previewMediaId: string | null;
  rungs: ContentRung[];
}

export interface ContentRung {
  rung: number; // 1..4
  mediaId: string | null;
  priceCents: number;
  description: string | null;
}

/** Load every script for a creator, each with its 4 rungs materialised. */
export async function listScriptsForCreator(creatorUuid: string): Promise<ContentScript[]> {
  const rows = await db
    .selectFrom("public.content_inventory_onlyfans")
    .selectAll()
    .where("creator_uuid", "=", creatorUuid)
    .orderBy("script_number", "asc")
    .execute();
  return rows.map(toScript);
}

/** Fetch a single script by (creator, script_number). */
export async function loadScript(
  creatorUuid: string,
  scriptNumber: number,
): Promise<ContentScript | null> {
  const row = await db
    .selectFrom("public.content_inventory_onlyfans")
    .selectAll()
    .where("creator_uuid", "=", creatorUuid)
    .where("script_number", "=", scriptNumber)
    .executeTakeFirst();
  return row ? toScript(row) : null;
}

function toScript(row: {
  id: string | number;
  script_number: number;
  script_name: string | null;
  preview_media_id: string | null;
  ppv1_media_id: string | null;
  ppv1_price: number;
  ppv1_description: string | null;
  ppv2_media_id: string | null;
  ppv2_price: number;
  ppv2_description: string | null;
  ppv3_media_id: string | null;
  ppv3_price: number;
  ppv3_description: string | null;
  ppv4_media_id: string | null;
  ppv4_price: number;
  ppv4_description: string | null;
  creator_uuid: string | null;
  creator_name: string | null;
  tag_creator: string | null;
  tags: string[];
}): ContentScript {
  // Prices in the legacy table are stored in cents-equivalent integers (the
  // defaults are 300/301/302/303 — interpreted as cents for internal math;
  // display conversion lives at the UI boundary).
  const rungs: ContentRung[] = [];
  if (row.ppv1_media_id)
    rungs.push({ rung: 1, mediaId: row.ppv1_media_id, priceCents: row.ppv1_price, description: row.ppv1_description });
  if (row.ppv2_media_id)
    rungs.push({ rung: 2, mediaId: row.ppv2_media_id, priceCents: row.ppv2_price, description: row.ppv2_description });
  if (row.ppv3_media_id)
    rungs.push({ rung: 3, mediaId: row.ppv3_media_id, priceCents: row.ppv3_price, description: row.ppv3_description });
  if (row.ppv4_media_id)
    rungs.push({ rung: 4, mediaId: row.ppv4_media_id, priceCents: row.ppv4_price, description: row.ppv4_description });

  // Unify tag_creator (legacy single-field) with the new tags array.
  const tagSet = new Set<string>(row.tags ?? []);
  if (row.tag_creator && row.tag_creator.trim()) tagSet.add(row.tag_creator.trim().toLowerCase());

  return {
    id: String(row.id),
    scriptNumber: row.script_number,
    scriptName: row.script_name,
    creatorUuid: row.creator_uuid,
    creatorName: row.creator_name,
    tagCreator: row.tag_creator,
    tags: Array.from(tagSet),
    previewMediaId: row.preview_media_id,
    rungs,
  };
}
