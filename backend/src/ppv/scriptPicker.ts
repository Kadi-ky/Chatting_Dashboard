import { logger } from "../observability/logger.js";
import { listScriptsForCreator, type ContentScript, type ContentRung } from "../db/repos/content_inventory.js";
import { listPurchasesByFan, deriveProgress, type FanScriptProgress } from "../db/repos/purchases.js";
import { upsertMirrorFromSource, type PpvCatalogRow } from "../db/repos/ppv_catalog.js";
import type { LatestArchetypeRow } from "../db/repos/archetypes.js";
import type { Phase } from "../state/types.js";

// REMOVED: VIP/whale price-floor logic. Per user direction (2026-04-27),
// the picker now treats every fan identically — no skipping of cheap rungs
// based on lifetime spend. Reasons:
//   1. The "skip cheap rungs for VIPs" behavior was the root cause of the
//      script-ordering bug where the picker would jump from S2R2 → S3R2,
//      because a VIP filter knocked out the natural next rung and the
//      topic-override path picked a cheaper rung in a different script.
//   2. The user wants the bot to walk every fan through the catalog ladder
//      in order. Whales who buy fast just complete the ladder faster — no
//      special framing required.
//   3. Removes a class of inscrutable behavior tied to lifetime-spend
//      thresholds that were hard to tune without per-creator catalog tuning.
//
// If you ever want to bring this back, do it as a per-creator config knob,
// not a global env var. The orchestrator's MIN_TURNS_BETWEEN_PITCHES still
// retains a WHALE phase entry — that's a separate decision (cooldown only).

export interface PickArgs {
  accountId: string;
  creatorUuid: string;
  /** Fan's external platform id — matches purchases_onlyfans.fan_uuid. */
  fanUuid: string;
  archetype: LatestArchetypeRow | null;
  phase: Phase;
  /**
   * Specific topic the fan asked for THIS turn (e.g. "feet", "lingerie").
   * When set, OVERRIDES the "continue in-progress script" preference and
   * searches all scripts for a tag match — the customer is always right,
   * pitch what they want even mid-ladder. Returns null if no script matches
   * the requested topic, so the caller can surface a graceful decline.
   */
  requestedTopic?: string | null;
}

export interface PickResult {
  asset: PpvCatalogRow;
  priceCents: number;
  /** "continue" = next rung of an in-progress script, "new" = rung 1 of a fresh script, "topic_match" = explicit fan request override. */
  reason: "continue" | "new" | "topic_match";
  scriptNumber: number;
  rung: number;
  // NOTE: previewMediaRef (free teaser flow) deferred to a future round —
  // requires extending OutboundJobData + adapter for attachment delivery,
  // which is too much to validate in the same run as the dryness/over-decline
  // fixes. Plumbing planned in scriptPicker.ts/orchestrator.ts/replyPipeline.ts.
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

  // PICKER PRIORITY ORDER (revised 2026-04-27):
  //
  //   1. In-progress script → continue it (next un-unlocked rung)
  //      The ladder ALWAYS wins. Once a fan is mid-arc on Script N, the next
  //      pick is Script N rung max+1. No topic override, no VIP filter, no
  //      jumping. This was the most common bug source — fan said "more like
  //      that" mid-S2, classifier flagged "boobs", picker jumped to S3R2.
  //
  //   2. Topic override (only if NO in-progress ladder)
  //      Fresh fan asks for "feet" → search for a feet-matching script and
  //      start it. Returns null if no match so caller can decline gracefully.
  //
  //   3. Sequential fresh start
  //      Lowest-numbered unstarted script, rung 1. Always rung 1 for fresh.
  //
  // No VIP-tier behavior anywhere — all fans walk the same ladder.

  // 1. CONTINUE IN-PROGRESS LADDER — always wins.
  const continuing = pickContinuingScript(scripts, progress);
  if (continuing) {
    return await materialise(args.accountId, args.creatorUuid, continuing.script, continuing.rung, "continue");
  }

  // 2. TOPIC OVERRIDE (only when fan has no in-progress script).
  if (args.requestedTopic && !isGenericTopic(args.requestedTopic)) {
    const topicMatch = pickByTopic(scripts, progress, args.requestedTopic);
    if (topicMatch) {
      logger.info(
        { fanUuid: args.fanUuid, topic: args.requestedTopic, scriptNumber: topicMatch.script.scriptNumber, rung: topicMatch.rung.rung },
        "scriptPicker: topic match (fresh fan asked for specific content)",
      );
      return await materialise(args.accountId, args.creatorUuid, topicMatch.script, topicMatch.rung, "topic_match");
    }
    // Specific request, no match in vault. Tell caller — DO NOT silently
    // fall through to "fresh script" because then the bot would pitch random
    // unrelated content to a fan who asked for X.
    logger.info(
      { fanUuid: args.fanUuid, topic: args.requestedTopic },
      "scriptPicker: no match for requested topic — caller should decline + suggest",
    );
    return null;
  }

  // 3. SEQUENTIAL FRESH START — lowest-numbered unstarted script, rung 1.
  const candidates = scripts.filter((s) => {
    const prog = progress.get(s.scriptNumber);
    if (prog) return false; // already started — handled by pickContinuingScript above
    if (s.rungs.length === 0) return false;
    return true;
  });
  if (candidates.length === 0) {
    logger.debug({ fanUuid: args.fanUuid }, "scriptPicker: no fresh scripts available");
    return null;
  }

  const ranked = rankFreshScripts(candidates, fanTags, args.phase);
  if (!ranked) return null;

  const firstRung = ranked.rungs.find((r) => r.rung === 1) ?? ranked.rungs[0];
  if (!firstRung) return null;
  return await materialise(args.accountId, args.creatorUuid, ranked, firstRung, "new");
}

/**
 * Generic catch-all asks that should NOT trigger the topic-override path —
 * any catalog item could plausibly satisfy them, so they should flow through
 * the normal ladder picker instead of being treated as kink-specific requests
 * the catalog might not have.
 */
const GENERIC_TOPICS = new Set([
  'pic', 'pics', 'photo', 'photos', 'image', 'images',
  'video', 'videos', 'vid', 'vids', 'clip', 'clips',
  'teaser', 'teasers', 'preview',
  'custom', 'customs', 'exclusive', 'exclusives',
  'something', 'anything', 'more', 'content', 'stuff',
  'nude', 'nudes', 'nsfw',
  'sext', 'sexting',
]);

function isGenericTopic(topic: string): boolean {
  return GENERIC_TOPICS.has(topic.toLowerCase().trim());
}

/**
 * Synonym expansion for requested topics. Fan asks "toy" — should match
 * descriptions with "dildo", "vibrator", "plug". Fan asks "bj" — should
 * match "sucking", "dick", "cock". Without this, the picker was too literal
 * and missed real matches (e.g. Script 2 rung 4 "dildo ride + butt plug"
 * didn't match a fan asking for "toy").
 */
const TOPIC_SYNONYMS: Record<string, string[]> = {
  toy: ['toy', 'toys', 'dildo', 'vibrator', 'plug', 'butt plug', 'suction'],
  dildo: ['dildo', 'toy', 'vibrator'],
  bj: ['bj', 'blowjob', 'blow job', 'sucking', 'suck', 'dick', 'cock', 'oral'],
  oral: ['oral', 'bj', 'sucking', 'suck', 'dick', 'blowjob'],
  anal: ['anal', 'butt', 'plug', 'ass'],
  ass: ['ass', 'butt', 'booty', 'cheek'],
  feet: ['feet', 'foot', 'soles', 'toes'],
  pussy: ['pussy', 'puss'],
  boobs: ['boobs', 'tits', 'titties', 'breast', 'chest', 'nipple'],
  tits: ['tits', 'boobs', 'titties', 'breast', 'nipple'],
  lingerie: ['lingerie', 'bra', 'panty', 'panties', 'underwear', 'thong'],
  shower: ['shower', 'bath', 'bathtub', 'wet', 'bathub'],
  cosplay: ['cosplay', 'outfit', 'costume'],
  custom_name: [],  // never matches — signals the picker to return null for graceful decline
};

function expandTopic(topic: string): string[] {
  const t = topic.toLowerCase().trim();
  return TOPIC_SYNONYMS[t] ?? [t];
}

/**
 * Find a script whose tags or descriptions match the fan's requested topic.
 * Prefer scripts where the fan is mid-ladder on a matching script (one that
 * matches the topic AND has unfinished rungs); otherwise pick the cheapest
 * matching fresh script's first rung. Match is loose substring on tags +
 * rung descriptions, expanded through TOPIC_SYNONYMS so "toy" also matches
 * "dildo" / "plug" etc.
 */
function pickByTopic(
  scripts: ContentScript[],
  progress: Map<number, FanScriptProgress>,
  topic: string,
): { script: ContentScript; rung: ContentRung } | null {
  const t = topic.toLowerCase().trim();
  if (!t) return null;

  // Expand the query through synonyms. "toy" → ["toy","dildo","vibrator","plug",...]
  // so a fan asking for a toy matches a description saying "dildo" or "butt plug".
  const queryTerms = expandTopic(t);
  if (queryTerms.length === 0) return null; // e.g. custom_name → no match on purpose

  // Collect EVERY un-unlocked rung whose description/tags/script-name actually
  // contain one of the query terms. Matching at the rung level (not script
  // level) was the old bug: a fan asking for "bj" matched Script 1 (because
  // rung 4 is "doing bj on a rooftop"), but the picker then returned rung 2
  // (boobs content) because that was the next un-unlocked rung. Now we only
  // return a rung if THAT specific rung matches the topic.
  type Candidate = { script: ContentScript; rung: ContentRung; ladderContinuation: boolean };
  const candidates: Candidate[] = [];
  for (const script of scripts) {
    const prog = progress.get(script.scriptNumber);
    const maxUnlocked = prog?.maxRungUnlocked ?? 0;
    const tagText = script.tags.map((tg) => tg.toLowerCase()).join(' ');
    const nameText = (script.scriptName ?? '').toLowerCase();
    for (const rung of script.rungs) {
      if (rung.rung <= maxUnlocked) continue;        // already unlocked
      const descText = (rung.description ?? '').toLowerCase();
      // Haystack: rung's own description PLUS script-level tags/name (so a
      // script-level tag like "bj" still matches even if the description is
      // abstract). Priority weighting: description hits rank higher below.
      const rungHay = descText;
      const scriptHay = `${tagText} ${nameText}`;
      const descMatch = queryTerms.some((q) => rungHay.includes(q));
      const scriptMatch = queryTerms.some((q) => scriptHay.includes(q));
      if (!descMatch && !scriptMatch) continue;
      // ladderContinuation = this rung is the very next one the fan hasn't
      // unlocked on a script they've already started (keeps the arc).
      const ladderContinuation = prog != null && rung.rung === maxUnlocked + 1;
      candidates.push({ script, rung, ladderContinuation });
    }
  }

  if (candidates.length === 0) return null;

  // Rank: description-match beats script-only-match, then ladder-continuation
  // beats fresh, then cheapest first-rung wins.
  candidates.sort((a, b) => {
    const aDescMatch = queryTerms.some((q) => (a.rung.description ?? '').toLowerCase().includes(q)) ? 1 : 0;
    const bDescMatch = queryTerms.some((q) => (b.rung.description ?? '').toLowerCase().includes(q)) ? 1 : 0;
    if (bDescMatch !== aDescMatch) return bDescMatch - aDescMatch;
    if (a.ladderContinuation !== b.ladderContinuation) return a.ladderContinuation ? -1 : 1;
    return a.rung.priceCents - b.rung.priceCents;
  });

  const best = candidates[0]!;
  return { script: best.script, rung: best.rung };
}

function pickContinuingScript(
  scripts: ContentScript[],
  progress: Map<number, FanScriptProgress>,
): { script: ContentScript; rung: ContentRung } | null {
  const inProgress: Array<{ script: ContentScript; progress: FanScriptProgress }> = [];
  for (const s of scripts) {
    const prog = progress.get(s.scriptNumber);
    if (!prog) continue;
    if (prog.maxRungUnlocked >= s.rungs.length) continue;
    inProgress.push({ script: s, progress: prog });
  }
  if (inProgress.length === 0) return null;
  // Most-recently-unlocked first — if a fan is mid-arc on multiple scripts
  // (rare, but possible from manual catalog reseeds), keep the freshest one
  // moving rather than reviving an older one.
  inProgress.sort((a, b) => b.progress.lastUnlockAt.getTime() - a.progress.lastUnlockAt.getTime());
  const pick = inProgress[0]!;
  // Pick the very next rung — no filtering, no skipping. The ladder runs
  // in order start to finish.
  const nextRungNum = pick.progress.maxRungUnlocked + 1;
  const rung = pick.script.rungs.find((r) => r.rung === nextRungNum);
  if (!rung) return null;
  return { script: pick.script, rung };
}

function rankFreshScripts(
  scripts: ContentScript[],
  fanTags: Set<string>,
  _phase: Phase,
): ContentScript | null {
  // SEQUENTIAL ORDER is the primary signal — Script 1, then Script 2, then
  // Script 3, then Script 4. Creators design ladders to be played in order;
  // jumping ahead to a higher-numbered script breaks the narrative arc
  // (and was the run-15 bug — fan finished Script 1, picker jumped to Script
  // 3 because tag overlap was higher).
  //
  // Tag overlap is now a tiny tiebreaker only — when two scripts have the
  // same number (impossible in practice, but kept for resilience) the better
  // tag match wins. Otherwise scriptNumber wins, full stop.
  let best: { script: ContentScript; score: number } | null = null;
  for (const s of scripts) {
    const overlap = fanTags.size === 0
      ? 0
      : s.tags.filter((t) => fanTags.has(t.toLowerCase())).length;

    // Higher score = higher priority. Sequential order dominates: subtract
    // scriptNumber * 1000 so Script 1 always outranks Script 2. Tag overlap
    // adds at most ~5 points — never enough to reorder scripts.
    const score = -s.scriptNumber * 1000 + overlap;

    if (!best || score > best.score) best = { script: s, score };
  }
  return best?.script ?? null;
}

async function materialise(
  accountId: string,
  creatorUuid: string,
  script: ContentScript,
  rung: ContentRung,
  reason: "continue" | "new" | "topic_match",
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
