import { logger } from "../observability/logger.js";
import { listScriptsForCreator, type ContentScript, type ContentRung } from "../db/repos/content_inventory.js";
import { listPurchasesByFan, deriveProgress, type FanScriptProgress } from "../db/repos/purchases.js";
import { upsertMirrorFromSource, type PpvCatalogRow } from "../db/repos/ppv_catalog.js";
import type { LatestArchetypeRow } from "../db/repos/archetypes.js";
import type { Phase } from "../state/types.js";

export interface PickArgs {
  accountId: string;
  creatorUuid: string;
  /** Fan's external platform id — matches purchases_onlyfans.fan_uuid. */
  fanUuid: string;
  archetype: LatestArchetypeRow | null;
  phase: Phase;
}

export interface PickResult {
  asset: PpvCatalogRow;
  priceCents: number;
  /** "continue" = next rung of an in-progress script, "new" = rung 1 of a fresh script. */
  reason: "continue" | "new";
  scriptNumber: number;
  rung: number;
}

/**
 * Pick the next PPV to pitch for a fan against the legacy 4-rung script model.
 *
 * Strategy:
 *   1. Prefer continuing an in-progress script (keeps narrative arc intact).
 *   2. Otherwise pick a new script ranked by tag overlap with the fan's
 *      archetype and a light phase-appropriateness bias.
 *
 * Once picked, lazy-upsert a shadow row into v3.ppv_catalog keyed by
 * source_ref so the V3 ppv_attempts + asset_performance FKs resolve cleanly.
 */
export async function pickNextForFan(args: PickArgs): Promise<PickResult | null> {
  const [scripts, purchases] = await Promise.all([
    listScriptsForCreator(args.creatorUuid),
    listPurchasesByFan(args.fanUuid, args.creatorUuid),
  ]);

  if (scripts.length === 0) {
    logger.debug({ creatorUuid: args.creatorUuid }, "scriptPicker: no content scripts");
    return null;
  }

  // Index scripts by number for the progress join.
  const byNumber = new Map<number, ContentScript>(scripts.map((s) => [s.scriptNumber, s]));

  // Reconstruct per-fan progress. Legacy rows may lack `rung` — fall back to
  // matching `amount_cents` against each rung's listed price.
  const inferRung = (scriptNumber: number, amountCents: number | null): number | null => {
    if (amountCents == null) return null;
    const script = byNumber.get(scriptNumber);
    if (!script) return null;
    const hit = script.rungs.find((r) => r.priceCents === amountCents);
    return hit?.rung ?? null;
  };
  const progress = deriveProgress(purchases, inferRung);

  const fanTags = new Set((args.archetype?.fetishTags ?? []).map((t) => t.toLowerCase()));

  // 1. Continuing an in-progress script is the strongest signal.
  const continuing = pickContinuingScript(scripts, progress);
  if (continuing) {
    return await materialise(args.accountId, args.creatorUuid, continuing.script, continuing.rung, "continue");
  }

  // 2. Pick a new script. Exclude ones already fully unlocked.
  const candidates = scripts.filter((s) => {
    const prog = progress.get(s.scriptNumber);
    if (!prog) return true;
    return prog.maxRungUnlocked < s.rungs.length;
  });
  if (candidates.length === 0) {
    logger.debug({ fanUuid: args.fanUuid }, "scriptPicker: all scripts fully unlocked");
    return null;
  }

  const ranked = rankFreshScripts(candidates, fanTags, args.phase);
  if (!ranked) return null;

  const firstRung = ranked.rungs[0];
  if (!firstRung) return null;
  return await materialise(args.accountId, args.creatorUuid, ranked, firstRung, "new");
}

function pickContinuingScript(
  scripts: ContentScript[],
  progress: Map<number, FanScriptProgress>,
): { script: ContentScript; rung: ContentRung } | null {
  // Multiple in-progress is possible if pitches came from different sources.
  // Prefer the one most recently unlocked — it's the freshest narrative thread.
  const inProgress: Array<{ script: ContentScript; progress: FanScriptProgress }> = [];
  for (const s of scripts) {
    const prog = progress.get(s.scriptNumber);
    if (!prog) continue;
    if (prog.maxRungUnlocked >= s.rungs.length) continue; // done
    inProgress.push({ script: s, progress: prog });
  }
  if (inProgress.length === 0) return null;
  inProgress.sort((a, b) => b.progress.lastUnlockAt.getTime() - a.progress.lastUnlockAt.getTime());
  const pick = inProgress[0]!;
  const nextRungNum = pick.progress.maxRungUnlocked + 1;
  const rung = pick.script.rungs.find((r) => r.rung === nextRungNum);
  if (!rung) return null;
  return { script: pick.script, rung };
}

function rankFreshScripts(
  scripts: ContentScript[],
  fanTags: Set<string>,
  phase: Phase,
): ContentScript | null {
  // Tag overlap is the primary signal. Ties broken by tag_creator having any
  // signal at all, then by script_number (stable preference for lower-number
  // scripts — these are typically the creator's opening arcs).
  let best: { script: ContentScript; score: number } | null = null;
  for (const s of scripts) {
    const overlap = fanTags.size === 0
      ? 0
      : s.tags.filter((t) => fanTags.has(t.toLowerCase())).length;

    // Base score starts at 1 so untagged scripts still rank against each other.
    let score = 1 + overlap * 2;

    // In QUALIFYING we prefer scripts whose first rung is on the cheaper side
    // (lowers commitment to start the ladder). In MONETIZING/WHALE we don't care.
    if (phase === "QUALIFYING" && s.rungs[0]) {
      const p = s.rungs[0].priceCents;
      if (p <= 500) score += 0.5;
    }

    // Prefer scripts that actually have all 4 rungs populated — more runway.
    if (s.rungs.length === 4) score += 0.2;

    if (!best || score > best.score) best = { script: s, score };
  }
  return best?.script ?? null;
}

async function materialise(
  accountId: string,
  creatorUuid: string,
  script: ContentScript,
  rung: ContentRung,
  reason: "continue" | "new",
): Promise<PickResult> {
  // source_ref must be parseable back to (creator, script_number, rung) so the
  // unlock handler can post a corresponding row to purchases_onlyfans.
  const sourceRef = `of:${creatorUuid}:${script.scriptNumber}:${rung.rung}`;
  const asset = await upsertMirrorFromSource({
    sourceRef,
    accountId,
    title: `${script.scriptName ?? `script ${script.scriptNumber}`} · rung ${rung.rung}`,
    description: rung.description,
    mediaRefs: rung.mediaId ? [{ ref: rung.mediaId, kind: "legacy_media_id" }] : [],
    tags: script.tags,
    // Legacy stores a fixed per-rung price, not a band. Collapse floor==ceiling.
    priceFloorCents: rung.priceCents,
    priceCeilingCents: rung.priceCents,
  });
  return {
    asset,
    priceCents: rung.priceCents,
    reason,
    scriptNumber: script.scriptNumber,
    rung: rung.rung,
  };
}
