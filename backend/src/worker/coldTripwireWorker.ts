import { sql, type SqlBool } from "kysely";
import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import { db } from "../db/client.js";
import { sharedRedis } from "../queue/redis.js";
import { outboundQueue } from "../queue/outbound.js";
import { insertOutboundDraft } from "../db/repos/messages.js";
import { ensureConversation } from "../db/repos/conversations.js";
import { isFanUnreachable } from "../platform/impl/http/unreachable.js";
import { isConversationDisengaged } from "./disengagement.js";
import { isConversationBotFlagged } from "./botDetection.js";
import { pickVoucherAsset } from "../voucher/picker.js";
import { generateTripwireCaption, generateImagePpvCaption, RECENT_VOUCHER_RING_MAX, RECENT_VOUCHER_TTL_SEC } from "../voucher/captionGenerator.js";
import { pickVaultImageForFan, recordVaultImageSent } from "../vault/vaultImages.js";

/**
 * Cold-tripwire mass-unlock worker. Part of the dormant-base activation push
 * (2026-06-05). Aimed at the ~3K subscribers who SUBSCRIBED but never replied
 * once (`last_inbound_at IS NULL`) — the cohort the warm-quiet voucher worker
 * DELIBERATELY skips (chat-quality audit 2026-05-27 found $50-99 vouchers to
 * pre-rapport fans converted at ~0%).
 *
 * The thesis is different from the voucher's: this is a FIRST-DOLLAR device,
 * not a discount. A ~$3.69 impulse unlock is a fundamentally different
 * psychological ask than a $69 "50% off" — the goal is to convert a $0 ghost
 * into a spender (the hardest barrier is the first purchase), which also wakes
 * the conversation so the bot can escalate.
 *
 * Kept as a SEPARATE worker (not a flag on voucherWorker) so the proven
 * warm-quiet voucher logic and its 0%-on-cold guard stay untouched.
 *
 * SAFETY (mirrors voucherWorker):
 *   - COLD_TRIPWIRE_ENABLED defaults false (master kill).
 *   - COLD_TRIPWIRE_DRY_RUN defaults true — logs would-send to the diag ring
 *     without enqueuing. A dry-run inspection MUST precede any real blast.
 *   - Skips unreachable fans, sticky-disengaged convs, bot-flagged convs,
 *     6h objection cooldown, and recent-inbound disengage keywords.
 *   - Per-fan 7-day cooldown (one tripwire per fan per week max).
 *   - Per-account per-tick cap (default 40) + UTC hour-gate paces the ~3K
 *     pool into a soft multi-hour drain under OFAPI's rate envelope.
 *
 * STATE STORAGE:
 *   Redis:
 *     peach:tripwire:lock:<accountId>:<fanExternalId>  — 7d TTL, per-fan cooldown
 *     peach:tripwire:recent:<accountId>                — last 12 captions for dedup
 */

const TICK_MS = 30 * 60_000;
const STARTUP_DELAY_MS = 90_000;
const TRIPWIRE_LOCK_TTL_SEC = 7 * 24 * 3600; // 7 days — one tripwire per fan per week

// Same hour-gate as voucher: 85% of unlocks land UTC 01-11 + late ramp.
const TRIPWIRE_SEND_HOURS_UTC = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 23]);

// Same disengagement patterns as voucher/nudge/outreach — economic refusal,
// polite blow-offs, explicit "stop", and emotional-disclosure/grief signals.
// A fan who's signalled any of these must not get blasted with a paid offer.
const DISENGAGE_PATTERNS = [
  /\bstop\b/i,
  /\bleave me alone\b/i,
  /\bunsub/i,
  /\bblock(?:ed|ing)?\b/i,
  /\bgoodbye\b/i,
  /\bnot interested\b/i,
  /\b(?:out of|no|low on|short on) (?:money|cash|funds)\b/i,
  /\b(?:cant?|can'?t|cannot)\s+afford\b/i,
  /\b(?:im|i am|i'?m)\s+broke\b/i,
  /\b(?:money|funds?|cash)\s+(?:so|too|are|is)?\s*low\b/i,
  /\bnext (?:paycheck|payday|paydate|check)\b/i,
  /\bsave\s+up\b/i,
  /\bfuneral(?:s)?\b/i,
  /\b(?:passed|died|death|dying|grief|loss|lost)\b/i,
  /\b(?:hospital|surgery|chemo|cancer|sick|illness)\b/i,
  /\b(?:depression|depressed|anxiety|breakdown|panic attack)\b/i,
  /\b(?:divorce|breakup|broke up|cheated on)\b/i,
];

const tripwireLockKey = (accountId: string, fanExternalId: string): string =>
  `peach:tripwire:lock:${accountId}:${fanExternalId}`;
const recentTripwireTextsKey = (accountId: string): string =>
  `peach:tripwire:recent:${accountId}`;

async function loadRecentTripwireTexts(accountId: string): Promise<string[]> {
  try {
    return await sharedRedis().lrange(recentTripwireTextsKey(accountId), 0, RECENT_VOUCHER_RING_MAX - 1);
  } catch {
    return [];
  }
}

async function recordRecentTripwireText(accountId: string, text: string): Promise<void> {
  try {
    const r = sharedRedis();
    const k = recentTripwireTextsKey(accountId);
    await r.lpush(k, text);
    await r.ltrim(k, 0, RECENT_VOUCHER_RING_MAX - 1);
    await r.expire(k, RECENT_VOUCHER_TTL_SEC);
  } catch {
    /* swallow */
  }
}

// ─── Recent-fires diag ring ──────────────────────────────────────────────

interface RecentTripwire {
  at: string;
  conversationId: string;
  fanExternalId: string;
  scriptNumber: number;
  rung: number;
  basePriceCents: number;
  tripwirePriceCents: number;
  caption: string;
  dryRun: boolean;
  vaultImageId?: string;
}
const RECENT_TRIPWIRES: RecentTripwire[] = [];
const RECENT_TRIPWIRES_MAX = 50;
export function getRecentTripwires(): RecentTripwire[] {
  return RECENT_TRIPWIRES.slice();
}

// ─── Allowlisted accounts (same pattern as voucher/subSync) ──────────────

async function allowlistedAccounts(): Promise<{ id: string; creatorUuid: string }[]> {
  const allow = env.PLATFORM_ACCOUNT_ALLOWLIST?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("acct_")) ?? [];
  if (allow.length === 0) return [];
  const rows = await db
    .selectFrom("v3.accounts")
    .select(["id", "creator_uuid"])
    .where("platform_account_id", "in", allow)
    .where("status", "=", "active")
    .execute();
  return rows
    .filter((r) => r.creator_uuid)
    .map((r) => ({ id: r.id, creatorUuid: r.creator_uuid as string }));
}

/**
 * Only pass a display name into the caption if it's plausibly a real first
 * name. The 2026-06-05 dry-run showed Hermes happily addressing fans as
 * "u467803395" / handles-with-digits when handed garbage display names.
 * Filter anything with digits, the literal external_id, or implausible
 * length — a wrong-but-name-shaped value is acceptable; a numeric handle is
 * jarring. Returns null to let the caption skip the name entirely.
 */
function realFirstName(name: string | null, externalId: string): string | null {
  if (!name) return null;
  const n = name.trim();
  if (n.length < 2 || n.length > 14) return null;
  if (/\d/.test(n)) return null;                    // names with digits = handles
  if (!/^[\p{L}][\p{L}\s'’-]*$/u.test(n)) return null; // letters/space/apostrophe/hyphen only
  if (n.toLowerCase() === externalId.toLowerCase()) return null;
  return n;
}

async function fanIsDisengaging(conversationId: string | null): Promise<boolean> {
  if (!conversationId) return false;
  const recent = await db
    .selectFrom("v3.messages")
    .select("text")
    .where("conversation_id", "=", conversationId)
    .where("direction", "=", "inbound")
    .orderBy("created_at", "desc")
    .limit(3)
    .execute();
  for (const r of recent) {
    if (DISENGAGE_PATTERNS.some((p) => p.test(r.text ?? ""))) return true;
  }
  return false;
}

// ─── Main pass ───────────────────────────────────────────────────────────

interface TripwirePassResult {
  account: string;
  candidates: number;
  sent: number;
  skippedUnreachable: number;
  skippedDisengage: number;
  skippedCooldown: number;
  skippedNoAsset: number;
  skippedNoCaption: number;
}

async function runForAccount(account: {
  id: string;
  creatorUuid: string;
}): Promise<TripwirePassResult> {
  const maxPerTick = env.COLD_TRIPWIRE_MAX_PER_TICK;

  // Cold cohort: subscribed but NEVER replied. This is exactly the cohort
  // the voucher worker excludes (it requires last_inbound_at IS NOT NULL).
  // No phase gate — cold fans are WARMUP by definition. Random sample so the
  // ~3K pool rotates across ticks instead of re-hitting the same head.
  const rows = await db
    .selectFrom("v3.subscribers as s")
    .innerJoin("v3.accounts as a", "a.id", "s.account_id")
    .leftJoin("v3.conversations as c", "c.subscriber_id", "s.id")
    .select([
      "s.id as subscriber_id",
      "s.external_id as fan_external_id",
      "s.display_name as display_name",
      "a.platform_account_id as platform_account_id",
    ])
    .where("s.account_id", "=", account.id)
    .where("a.platform_account_id", "is not", null)
    .where("s.last_inbound_at", "is", null) // never replied — the cold lurker pool
    .where(sql<SqlBool>`s.external_id NOT LIKE 'loop-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'longtime-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE '%-probe-%'`)
    .orderBy(sql`random()`)
    .limit(200)
    .execute();

  const result: TripwirePassResult = {
    account: account.id,
    candidates: rows.length,
    sent: 0,
    skippedUnreachable: 0,
    skippedDisengage: 0,
    skippedCooldown: 0,
    skippedNoAsset: 0,
    skippedNoCaption: 0,
  };

  for (const row of rows) {
    if (result.sent >= maxPerTick) break;
    try {
      const platformAccountId = row.platform_account_id as string;

      // Per-fan cooldown (7d)
      const locked = await sharedRedis().get(tripwireLockKey(account.id, row.fan_external_id));
      if (locked) {
        result.skippedCooldown++;
        continue;
      }

      // Skip dead fans
      if (await isFanUnreachable(platformAccountId, row.fan_external_id)) {
        result.skippedUnreachable++;
        continue;
      }

      // Ensure conversation + disengagement guards FIRST (before asset
      // selection) — vault-image dedup is keyed on convId, and skipping a
      // disengaged fan before the asset/caption work is cheaper anyway.
      // A cold fan has last_inbound_at IS NULL (zero inbounds) so the
      // keyword scan rarely fires, but the sticky-flag / bot-flag / objection
      // cooldown can be set out-of-band, so keep the full guard stack.
      const { id: convId } = await ensureConversation({
        subscriberId: row.subscriber_id,
        accountId: account.id,
      });
      if (await isConversationDisengaged(convId)) {
        result.skippedDisengage++;
        continue;
      }
      if (await isConversationBotFlagged(convId)) {
        result.skippedDisengage++;
        continue;
      }
      const objCooldown = await sharedRedis()
        .get(`peach:objection:cooldown:${convId}`)
        .catch(() => null);
      if (objCooldown) {
        result.skippedDisengage++;
        continue;
      }
      if (await fanIsDisengaging(convId)) {
        result.skippedDisengage++;
        continue;
      }

      // Flat tripwire price (NOT the $50-99 voucher tier function).
      const tripwirePriceCents = env.COLD_TRIPWIRE_PRICE_CENTS;
      const impliedRegularCents = tripwirePriceCents * 2; // for "50% off" math
      const recentTexts = await loadRecentTripwireTexts(account.id);

      // Asset: either a live VAULT PHOTO (when the flag is on) or a curated
      // script asset. Vault image = ideal cheap impulse buy; needs no asset
      // description (the image caption sells the single pic). diag* fields
      // describe the asset for the recent-fires ring.
      let mediaRef: string;
      let assetIdForJob: string;
      let caption: string | null;
      let diagScriptNumber = 0;
      let diagRung = 0;
      let diagBasePrice = 0;
      let isVaultImage = false;

      if (env.COLD_TRIPWIRE_USE_VAULT_IMAGES) {
        const imageId = await pickVaultImageForFan(platformAccountId, convId);
        if (!imageId) {
          result.skippedNoAsset++;
          continue;
        }
        isVaultImage = true;
        mediaRef = imageId;
        assetIdForJob = `vault:${imageId}`;
        caption = await generateImagePpvCaption({
          accountId: account.id,
          subscriberId: row.subscriber_id,
          fanExternalId: row.fan_external_id,
          fanDisplayName: realFirstName(row.display_name, row.fan_external_id),
          priceCents: tripwirePriceCents,
          impliedRegularPriceCents: impliedRegularCents,
          mode: "cold",
          recentTexts,
        });
      } else {
        const pick = await pickVoucherAsset({
          fanExternalId: row.fan_external_id,
          creatorUuid: account.creatorUuid,
        });
        if (!pick) {
          result.skippedNoAsset++;
          continue;
        }
        mediaRef = pick.mediaId;
        assetIdForJob = pick.scriptId;
        diagScriptNumber = pick.scriptNumber;
        diagRung = pick.rung;
        diagBasePrice = pick.basePriceCents;
        caption = await generateTripwireCaption({
          accountId: account.id,
          subscriberId: row.subscriber_id,
          fanExternalId: row.fan_external_id,
          fanDisplayName: realFirstName(row.display_name, row.fan_external_id),
          scriptName: pick.scriptName,
          assetDescription: pick.description,
          tripwirePriceCents,
          impliedRegularPriceCents: impliedRegularCents,
          recentTexts,
        });
      }
      if (!caption) {
        result.skippedNoCaption++;
        continue;
      }

      // Lock BEFORE send for race protection; roll back on enqueue failure so
      // a transient error doesn't silently skip the fan for 7 days.
      const lockKey = tripwireLockKey(account.id, row.fan_external_id);
      await sharedRedis().set(lockKey, "1", "EX", TRIPWIRE_LOCK_TTL_SEC);

      const dryRunEffective = env.COLD_TRIPWIRE_DRY_RUN;
      const entry: RecentTripwire = {
        at: new Date().toISOString(),
        conversationId: convId,
        fanExternalId: row.fan_external_id,
        scriptNumber: diagScriptNumber,
        rung: diagRung,
        basePriceCents: diagBasePrice,
        tripwirePriceCents,
        caption,
        dryRun: dryRunEffective,
        ...(isVaultImage ? { vaultImageId: mediaRef } : {}),
      };
      RECENT_TRIPWIRES.unshift(entry);
      if (RECENT_TRIPWIRES.length > RECENT_TRIPWIRES_MAX) RECENT_TRIPWIRES.length = RECENT_TRIPWIRES_MAX;

      if (dryRunEffective) {
        // Dry-run: log only, don't poison the dedup ring or enqueue.
        await sharedRedis().del(lockKey).catch(() => undefined); // don't burn the 7d lock on a non-send
        logger.info(entry, "tripwire dry-run (no send, no ring-record)");
        result.sent++;
        continue;
      }

      try {
        const { id: messageId } = await insertOutboundDraft({
          conversationId: convId,
          text: caption,
          kind: "ppv",
          attachments: [{ assetRef: mediaRef, priceCents: tripwirePriceCents }],
        });
        await outboundQueue().add(
          "tripwire",
          {
            accountId: account.id,
            conversationId: convId,
            subscriberId: row.subscriber_id,
            subscriberExternalId: row.fan_external_id,
            kind: "ppv",
            messageId,
            text: caption,
            ppv: {
              assetId: assetIdForJob,
              assetRef: mediaRef,
              priceCents: tripwirePriceCents,
            },
            bubbleIndex: 0,
            bubbleCount: 1,
          },
          { jobId: `tripwire-${messageId}` },
        );
        await recordRecentTripwireText(account.id, caption);
        if (isVaultImage) await recordVaultImageSent(convId, mediaRef);
        logger.info(entry, "tripwire enqueued");
        result.sent++;
      } catch (enqErr) {
        await sharedRedis().del(lockKey).catch(() => undefined);
        logger.warn(
          {
            err: enqErr instanceof Error ? enqErr.message : enqErr,
            subscriberId: row.subscriber_id,
            fanExternalId: row.fan_external_id,
          },
          "tripwire enqueue failed — cooldown lock rolled back",
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, subscriberId: row.subscriber_id },
        "tripwire send failed for one sub",
      );
    }
  }

  return result;
}

/**
 * Manual trigger — runs one tripwire pass per account right now. Used by
 * /admin/cold-tripwire-now to verify behavior (esp. dry-run captions) without
 * waiting for the 30-min tick. Repeated calls drain the cold pool.
 */
export async function triggerColdTripwireNow(): Promise<{ results: TripwirePassResult[] }> {
  const accounts = await allowlistedAccounts();
  const results: TripwirePassResult[] = [];
  for (const a of accounts) {
    results.push(await runForAccount(a));
  }
  return { results };
}

export interface ColdTripwireWorkerHandle {
  stop: () => Promise<void>;
}

export function startColdTripwireWorker(): ColdTripwireWorkerHandle | null {
  if (!env.COLD_TRIPWIRE_ENABLED) {
    logger.info("cold tripwire worker disabled (COLD_TRIPWIRE_ENABLED=false)");
    return null;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const hourUtc = new Date().getUTCHours();
    if (!TRIPWIRE_SEND_HOURS_UTC.has(hourUtc)) {
      logger.debug({ hourUtc }, "tripwire tick skipped — outside send window");
      if (!stopped) timer = setTimeout(tick, TICK_MS);
      return;
    }
    try {
      const accounts = await allowlistedAccounts();
      const results: TripwirePassResult[] = [];
      for (const a of accounts) {
        results.push(await runForAccount(a));
      }
      const totalSent = results.reduce((s, r) => s + r.sent, 0);
      const totalCandidates = results.reduce((s, r) => s + r.candidates, 0);
      if (totalSent > 0 || totalCandidates > 0) {
        logger.info({ results, totalSent, totalCandidates }, "tripwire tick");
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "tripwire tick failed",
      );
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_MS);
    }
  };

  timer = setTimeout(tick, STARTUP_DELAY_MS);
  logger.info(
    {
      tickMs: TICK_MS,
      dryRun: env.COLD_TRIPWIRE_DRY_RUN,
      priceCents: env.COLD_TRIPWIRE_PRICE_CENTS,
      maxPerTick: env.COLD_TRIPWIRE_MAX_PER_TICK,
    },
    "cold tripwire worker started",
  );

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
