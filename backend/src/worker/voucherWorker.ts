import { sql, type SqlBool } from "kysely";
import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import { db } from "../db/client.js";
import { sharedRedis } from "../queue/redis.js";
import { outboundQueue } from "../queue/outbound.js";
import { insertOutboundDraft } from "../db/repos/messages.js";
import { ensureConversation } from "../db/repos/conversations.js";
import { isFanUnreachable } from "../platform/impl/http/unreachable.js";
import { pickVoucherAsset } from "../voucher/picker.js";
import { calculateVoucherPriceCents, impliedRegularPriceCents } from "../voucher/pricing.js";
import { generateVoucherCaption, RECENT_VOUCHER_RING_MAX, RECENT_VOUCHER_TTL_SEC } from "../voucher/captionGenerator.js";

/**
 * Voucher mass-send worker. Operator brief 2026-05-14: send dynamic PPVs
 * (different per fan based on what they've already bought) to silent/lurking
 * subs, framed as "50% off voucher" but priced in the $50-$99 tier. Goal:
 * boost sales by re-engaging the long-tail with a high-margin tripwire
 * different from the rapport-building cold outreach worker.
 *
 * Differences from outreachWorker:
 *   - Sends are PRICED PPVs, not text chat (the send IS the voucher).
 *   - Per-fan 2-day cooldown (operator-specified).
 *   - Asset picker: unbought-only, prefers untouched scripts for variety.
 *   - Price calculated per asset rung, bumped into $50-$99 voucher tier.
 *   - Voice loads per-account persona so Khlo and Ari each pitch in
 *     character (sex-demon Ari sends very different vouchers than
 *     bratty-Khlo).
 *
 * Operates over all PLATFORM_ACCOUNT_ALLOWLIST entries.
 *
 * SAFETY:
 *   - VOUCHER_ENABLED env defaults false (master kill) — flip to true on
 *     Railway to activate.
 *   - VOUCHER_DRY_RUN logs would-send entries to the diag ring without
 *     enqueuing the actual PPV send. Use to verify caption quality + asset
 *     selection before going live.
 *   - Skips fans flagged as unreachable (peach:fan:unreachable Redis flag).
 *   - Skips fans with disengagement signals in last 3 inbounds (broke /
 *     not interested / etc — same patterns as nudge + outreach workers).
 *   - Skips fans actively chatting (last inbound < 24h ago) — voucher is
 *     for silent fans, not active conversations.
 *   - Per-account per-tick cap (25 sends) to keep OFAPI rate budget sane.
 *   - Random sample of 100 candidates per tick + cap of 25 = rotates
 *     through the silent-fan pool naturally over many ticks.
 *
 * STATE STORAGE:
 *   Redis:
 *     peach:voucher:lock:<accountId>:<fanExternalId>  — 2d TTL, gates per-fan cooldown
 *     peach:voucher:recent:<accountId>                — list of last 12 captions for dedup
 */

const TICK_MS = 30 * 60_000;
const STARTUP_DELAY_MS = 90_000; // 90s — let DB pools settle + give other workers a head start
const VOUCHER_LOCK_TTL_SEC = 2 * 24 * 3600; // 2 days, operator-specified
const MAX_PER_TICK_PER_ACCOUNT = 25;
const MIN_HOURS_SINCE_INBOUND = 24; // skip actively-chatting fans

// Same disengagement patterns as nudge/outreach workers — economic signals,
// polite blow-offs, and explicit refusal. Fans who've signalled these
// shouldn't get blasted with a paid voucher.
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
];

const voucherLockKey = (accountId: string, fanExternalId: string): string =>
  `peach:voucher:lock:${accountId}:${fanExternalId}`;
const recentVoucherTextsKey = (accountId: string): string =>
  `peach:voucher:recent:${accountId}`;

async function loadRecentVoucherTexts(accountId: string): Promise<string[]> {
  try {
    return await sharedRedis().lrange(recentVoucherTextsKey(accountId), 0, RECENT_VOUCHER_RING_MAX - 1);
  } catch {
    return [];
  }
}

async function recordRecentVoucherText(accountId: string, text: string): Promise<void> {
  try {
    const r = sharedRedis();
    const k = recentVoucherTextsKey(accountId);
    await r.lpush(k, text);
    await r.ltrim(k, 0, RECENT_VOUCHER_RING_MAX - 1);
    await r.expire(k, RECENT_VOUCHER_TTL_SEC);
  } catch {
    /* swallow */
  }
}

// ─── Recent-fires diag ring ──────────────────────────────────────────────

interface RecentVoucher {
  at: string;
  conversationId: string;
  fanExternalId: string;
  scriptNumber: number;
  rung: number;
  basePriceCents: number;
  voucherPriceCents: number;
  caption: string;
  dryRun: boolean;
}
const RECENT_VOUCHERS: RecentVoucher[] = [];
const RECENT_VOUCHERS_MAX = 50;
export function getRecentVouchers(): RecentVoucher[] {
  return RECENT_VOUCHERS.slice();
}

// ─── Allowlisted accounts (same pattern as subSyncWorker) ────────────────

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

interface VoucherPassResult {
  account: string;
  candidates: number;
  sent: number;
  skippedUnreachable: number;
  skippedActive: number;
  skippedDisengage: number;
  skippedCooldown: number;
  skippedNoAsset: number;
  skippedNoCaption: number;
}

async function runForAccount(account: {
  id: string;
  creatorUuid: string;
}): Promise<VoucherPassResult> {
  const inboundCutoff = new Date(Date.now() - MIN_HOURS_SINCE_INBOUND * 3600_000);

  const rows = await db
    .selectFrom("v3.subscribers as s")
    .innerJoin("v3.accounts as a", "a.id", "s.account_id")
    .select([
      "s.id as subscriber_id",
      "s.external_id as fan_external_id",
      "s.display_name as display_name",
      "s.last_inbound_at as last_inbound_at",
      "a.platform_account_id as platform_account_id",
    ])
    .where("s.account_id", "=", account.id)
    .where("a.platform_account_id", "is not", null)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'loop-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'longtime-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE '%-probe-%'`)
    .where(sql<SqlBool>`(s.last_inbound_at IS NULL OR s.last_inbound_at < ${inboundCutoff})`)
    .orderBy(sql`random()`)
    .limit(150)
    .execute();

  const result: VoucherPassResult = {
    account: account.id,
    candidates: rows.length,
    sent: 0,
    skippedUnreachable: 0,
    skippedActive: 0,
    skippedDisengage: 0,
    skippedCooldown: 0,
    skippedNoAsset: 0,
    skippedNoCaption: 0,
  };

  for (const row of rows) {
    if (result.sent >= MAX_PER_TICK_PER_ACCOUNT) break;
    try {
      const platformAccountId = row.platform_account_id as string;

      // Per-fan cooldown
      const locked = await sharedRedis().get(voucherLockKey(account.id, row.fan_external_id));
      if (locked) {
        result.skippedCooldown++;
        continue;
      }

      // Skip dead fans
      if (await isFanUnreachable(platformAccountId, row.fan_external_id)) {
        result.skippedUnreachable++;
        continue;
      }

      // Pick an asset the fan hasn't bought
      const pick = await pickVoucherAsset({
        fanExternalId: row.fan_external_id,
        creatorUuid: account.creatorUuid,
      });
      if (!pick) {
        result.skippedNoAsset++;
        continue;
      }

      // Ensure conversation row + disengagement check
      const { id: convId } = await ensureConversation({
        subscriberId: row.subscriber_id,
        accountId: account.id,
      });
      if (await fanIsDisengaging(convId)) {
        result.skippedDisengage++;
        continue;
      }

      // Calculate voucher price
      const voucherPriceCents = calculateVoucherPriceCents(pick.basePriceCents);

      // Generate caption with account voice
      const recentTexts = await loadRecentVoucherTexts(account.id);
      const caption = await generateVoucherCaption({
        accountId: account.id,
        subscriberId: row.subscriber_id,
        fanExternalId: row.fan_external_id,
        fanDisplayName: row.display_name,
        scriptName: pick.scriptName,
        assetDescription: pick.description,
        voucherPriceCents,
        impliedRegularPriceCents: impliedRegularPriceCents(voucherPriceCents),
        recentTexts,
      });
      if (!caption) {
        result.skippedNoCaption++;
        continue;
      }

      // Set lock + diag ring BEFORE send so concurrent ticks can't double-fire
      await sharedRedis().set(
        voucherLockKey(account.id, row.fan_external_id),
        "1",
        "EX",
        VOUCHER_LOCK_TTL_SEC,
      );

      const dryRunEffective = env.VOUCHER_DRY_RUN;
      const entry: RecentVoucher = {
        at: new Date().toISOString(),
        conversationId: convId,
        fanExternalId: row.fan_external_id,
        scriptNumber: pick.scriptNumber,
        rung: pick.rung,
        basePriceCents: pick.basePriceCents,
        voucherPriceCents,
        caption,
        dryRun: dryRunEffective,
      };
      RECENT_VOUCHERS.unshift(entry);
      if (RECENT_VOUCHERS.length > RECENT_VOUCHERS_MAX) RECENT_VOUCHERS.length = RECENT_VOUCHERS_MAX;

      await recordRecentVoucherText(account.id, caption);

      if (dryRunEffective) {
        logger.info(entry, "voucher dry-run (no send)");
        result.sent++;
        continue;
      }

      // Insert message + enqueue PPV send
      const { id: messageId } = await insertOutboundDraft({
        conversationId: convId,
        text: caption,
        kind: "ppv",
        attachments: [{ assetRef: pick.mediaId, priceCents: voucherPriceCents }],
      });
      await outboundQueue().add(
        "voucher",
        {
          accountId: account.id,
          conversationId: convId,
          subscriberId: row.subscriber_id,
          subscriberExternalId: row.fan_external_id,
          kind: "ppv",
          messageId,
          text: caption,
          ppv: {
            assetId: pick.scriptId,
            assetRef: pick.mediaId,
            priceCents: voucherPriceCents,
          },
          bubbleIndex: 0,
          bubbleCount: 1,
        },
        { jobId: `voucher-${messageId}` },
      );

      logger.info(entry, "voucher enqueued");
      result.sent++;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, subscriberId: row.subscriber_id },
        "voucher send failed for one sub",
      );
    }
  }

  return result;
}

/**
 * Manual trigger — runs one voucher pass per account right now. Used by
 * /admin/voucher-now to verify behavior without waiting for the 30min tick.
 */
export async function triggerVoucherNow(): Promise<{ results: VoucherPassResult[] }> {
  const accounts = await allowlistedAccounts();
  const results: VoucherPassResult[] = [];
  for (const a of accounts) {
    results.push(await runForAccount(a));
  }
  return { results };
}

export interface VoucherWorkerHandle {
  stop: () => Promise<void>;
}

export function startVoucherWorker(): VoucherWorkerHandle | null {
  if (!env.VOUCHER_ENABLED) {
    logger.info("voucher worker disabled (VOUCHER_ENABLED=false)");
    return null;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const accounts = await allowlistedAccounts();
      const results: VoucherPassResult[] = [];
      for (const a of accounts) {
        results.push(await runForAccount(a));
      }
      const totalSent = results.reduce((s, r) => s + r.sent, 0);
      const totalCandidates = results.reduce((s, r) => s + r.candidates, 0);
      if (totalSent > 0 || totalCandidates > 0) {
        logger.info({ results, totalSent, totalCandidates }, "voucher tick");
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "voucher tick failed",
      );
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_MS);
    }
  };

  timer = setTimeout(tick, STARTUP_DELAY_MS);
  logger.info(
    { tickMs: TICK_MS, dryRun: env.VOUCHER_DRY_RUN, maxPerTick: MAX_PER_TICK_PER_ACCOUNT },
    "voucher worker started",
  );

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
