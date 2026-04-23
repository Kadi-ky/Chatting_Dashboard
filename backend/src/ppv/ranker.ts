import type { LatestArchetypeRow } from "../db/repos/archetypes.js";
import type { PpvCatalogRow } from "../db/repos/ppv_catalog.js";
import type { AssetPerformanceRow, ArchetypeSlice } from "../db/repos/asset_performance.js";

export interface RankedAsset {
  asset: PpvCatalogRow;
  score: number;
  suggestedPriceCents: number;
}

export interface RankArgs {
  catalog: PpvCatalogRow[];
  archetype: LatestArchetypeRow | null;
  perfBySlice: Map<string, AssetPerformanceRow>;
  /** asset ids to exclude (cooldown + already-unlocked). */
  excludeAssetIds: Set<string>;
  /** Phase — MONETIZING can relax the tag-match filter. */
  relaxTagMatch: boolean;
}

/**
 * Rank candidate PPV assets for a subscriber. Returns the top ranked asset (or
 * null if nothing qualifies).
 *
 * Score = expected_unlock_rate * price * freshness_decay * tag_match_bonus
 *   - expected_unlock_rate: per-slice unlocks/attempts (prior 0.1 when < 5 attempts)
 *   - price: mid of the asset's allowed band, adjusted by price sensitivity
 *   - freshness: exp decay, half-life 60d
 *   - tag_match_bonus: 1.5x if any overlap with fan's fetish tags
 */
export function rankAssets(args: RankArgs): RankedAsset | null {
  const now = Date.now();
  const fanTags = new Set(args.archetype?.fetishTags ?? []);
  const scored: RankedAsset[] = [];

  for (const asset of args.catalog) {
    if (args.excludeAssetIds.has(asset.id)) continue;

    const overlap = asset.tags.filter((t) => fanTags.has(t)).length;
    if (!args.relaxTagMatch && fanTags.size > 0 && overlap === 0) continue;

    const perf = args.perfBySlice.get(asset.id);
    const attempts = perf?.attempts ?? 0;
    const unlocks = perf?.unlocks ?? 0;
    const priorWeight = 0.1;
    const priorAttempts = 5;
    const expectedUnlockRate =
      (unlocks + priorWeight * priorAttempts) / (attempts + priorAttempts);

    const price = pickPriceCents(asset, args.archetype?.priceSensitivity ?? "mid");

    const ageMs = now - asset.createdAt.getTime();
    const halfLifeMs = 60 * 86_400_000;
    const freshness = Math.pow(0.5, ageMs / halfLifeMs);

    const tagBonus = overlap > 0 ? 1.5 : 1.0;

    const score = expectedUnlockRate * price * freshness * tagBonus;

    scored.push({ asset, score, suggestedPriceCents: price });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? null;
}

export function pickPriceCents(
  asset: PpvCatalogRow,
  priceSensitivity: "low" | "mid" | "high",
): number {
  const lo = asset.priceFloorCents;
  const hi = asset.priceCeilingCents;
  const span = Math.max(0, hi - lo);
  const frac = priceSensitivity === "high" ? 0.15 : priceSensitivity === "low" ? 0.75 : 0.5;
  // Small deterministic jitter around the anchor so identical archetypes don't all land on the same price.
  const jitter = (Math.random() - 0.5) * 0.1 * span;
  return Math.max(lo, Math.min(hi, Math.round(lo + frac * span + jitter)));
}

export function archetypeSlice(a: LatestArchetypeRow | null): ArchetypeSlice {
  if (!a) return { spenderTier: "never", priceSensitivity: "mid" };
  return { spenderTier: a.spenderTier, priceSensitivity: a.priceSensitivity };
}
