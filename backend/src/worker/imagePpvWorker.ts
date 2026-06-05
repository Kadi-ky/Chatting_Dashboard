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
import { generateImagePpvCaption, RECENT_VOUCHER_RING_MAX, RECENT_VOUCHER_TTL_SEC } from "../voucher/captionGenerator.js";
import { pickVaultImageForFan, recordVaultImageSent } from "../vault/vaultImages.js";

/**
 * Image-PPV worker. Sells individual VAULT PHOTOS (sourced live from
 * OnlyFansAPI's media vault) to WARM-but-quiet fans — those who've chatted
 * before and gone quiet — as a standalone path separate from the cold
 * tripwire. One hot pic at a low price ($5.99 default) is a low-friction
 * re-open: cheaper than a $50-99 voucher, more personal than a script bundle.
 *
 * Differs from the cold tripwire (which targets never-replied lurkers at
 * $3.69): this targets ENGAGED fans (last_inbound_at NOT NULL, recently quiet)
 * and uses the "warm" image-caption framing. Per-fan vault-image dedup is
 * shared with the tripwire (peach:vault:sent:<conv>) so a fan never gets the
 * same photo twice across either path.
 *
 * SAFETY (mirrors voucher/tripwire): IMAGE_PPV_ENABLED default false,
 * IMAGE_PPV_DRY_RUN default true; skips unreachable / disengaged / bot-flagged
 * / objection-cooldown fans; per-fan 5-day cooldown; per-account per-tick cap;
 * UTC hour-gate.
 */

const TICK_MS = 30 * 60_000;
const STARTUP_DELAY_MS = 95_000;
const IMAGE_PPV_LOCK_TTL_SEC = 5 * 24 * 3600; // one image-PPV per fan per 5d
const MIN_HOURS_SINCE_INBOUND = 24; // skip actively-chatting fans
const MAX_DAYS_SINCE_INBOUND = 21;  // skip fully-dormant fans
const SEND_HOURS_UTC = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 23]);
// Warm fans only — WARMUP/COLD are effectively cold and belong to the tripwire.
// Eligible phases (RAPPORT/QUALIFYING/MONETIZING/SEXTING/WHALE) are inlined as
// a SQL literal in the candidate query below.

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

const imagePpvLockKey = (accountId: string, fanExternalId: string): string =>
  `peach:imageppv:lock:${accountId}:${fanExternalId}`;
const recentImagePpvTextsKey = (accountId: string): string => `peach:imageppv:recent:${accountId}`;

async function loadRecentImagePpvTexts(accountId: string): Promise<string[]> {
  try {
    return await sharedRedis().lrange(recentImagePpvTextsKey(accountId), 0, RECENT_VOUCHER_RING_MAX - 1);
  } catch {
    return [];
  }
}
async function recordRecentImagePpvText(accountId: string, text: string): Promise<void> {
  try {
    const r = sharedRedis();
    const k = recentImagePpvTextsKey(accountId);
    await r.lpush(k, text);
    await r.ltrim(k, 0, RECENT_VOUCHER_RING_MAX - 1);
    await r.expire(k, RECENT_VOUCHER_TTL_SEC);
  } catch {
    /* swallow */
  }
}

interface RecentImagePpv {
  at: string;
  conversationId: string;
  fanExternalId: string;
  vaultImageId: string;
  priceCents: number;
  caption: string;
  dryRun: boolean;
}
const RECENT_IMAGE_PPV: RecentImagePpv[] = [];
const RECENT_IMAGE_PPV_MAX = 50;
export function getRecentImagePpv(): RecentImagePpv[] {
  return RECENT_IMAGE_PPV.slice();
}

async function allowlistedAccounts(): Promise<{ id: string; platformAccountId: string }[]> {
  const allow = env.PLATFORM_ACCOUNT_ALLOWLIST?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("acct_")) ?? [];
  if (allow.length === 0) return [];
  const rows = await db
    .selectFrom("v3.accounts")
    .select(["id", "platform_account_id"])
    .where("platform_account_id", "in", allow)
    .where("status", "=", "active")
    .execute();
  return rows
    .filter((r) => r.platform_account_id)
    .map((r) => ({ id: r.id, platformAccountId: r.platform_account_id as string }));
}

async function fanIsDisengaging(conversationId: string): Promise<boolean> {
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

interface ImagePpvPassResult {
  account: string;
  candidates: number;
  sent: number;
  skippedUnreachable: number;
  skippedDisengage: number;
  skippedCooldown: number;
  skippedNoImage: number;
  skippedNoCaption: number;
}

async function runForAccount(account: { id: string; platformAccountId: string }): Promise<ImagePpvPassResult> {
  const inboundCutoff = new Date(Date.now() - MIN_HOURS_SINCE_INBOUND * 3600_000);
  const dormantCutoff = new Date(Date.now() - MAX_DAYS_SINCE_INBOUND * 24 * 3600_000);

  // Warm but quiet: chatted before, last inbound 24h-21d ago, engaged phase.
  const rows = await db
    .selectFrom("v3.subscribers as s")
    .innerJoin("v3.accounts as a", "a.id", "s.account_id")
    .leftJoin("v3.conversations as c", "c.subscriber_id", "s.id")
    .select([
      "s.id as subscriber_id",
      "s.external_id as fan_external_id",
      "s.display_name as display_name",
    ])
    .where("s.account_id", "=", account.id)
    .where("a.platform_account_id", "is not", null)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'loop-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'longtime-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE '%-probe-%'`)
    .where("s.last_inbound_at", "is not", null)
    .where(sql<SqlBool>`s.last_inbound_at < ${inboundCutoff}`)
    .where(sql<SqlBool>`s.last_inbound_at > ${dormantCutoff}`)
    .where(sql<SqlBool>`c.phase IN ('RAPPORT', 'QUALIFYING', 'MONETIZING', 'SEXTING', 'WHALE')`)
    .orderBy(sql`random()`)
    .limit(150)
    .execute();

  const result: ImagePpvPassResult = {
    account: account.id,
    candidates: rows.length,
    sent: 0,
    skippedUnreachable: 0,
    skippedDisengage: 0,
    skippedCooldown: 0,
    skippedNoImage: 0,
    skippedNoCaption: 0,
  };

  const priceCents = env.IMAGE_PPV_PRICE_CENTS;
  const impliedRegularCents = priceCents * 2;

  for (const row of rows) {
    if (result.sent >= env.IMAGE_PPV_MAX_PER_TICK) break;
    try {
      const locked = await sharedRedis().get(imagePpvLockKey(account.id, row.fan_external_id));
      if (locked) {
        result.skippedCooldown++;
        continue;
      }
      if (await isFanUnreachable(account.platformAccountId, row.fan_external_id)) {
        result.skippedUnreachable++;
        continue;
      }

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
      const objCooldown = await sharedRedis().get(`peach:objection:cooldown:${convId}`).catch(() => null);
      if (objCooldown) {
        result.skippedDisengage++;
        continue;
      }
      if (await fanIsDisengaging(convId)) {
        result.skippedDisengage++;
        continue;
      }

      const imageId = await pickVaultImageForFan(account.platformAccountId, convId);
      if (!imageId) {
        result.skippedNoImage++;
        continue;
      }

      const recentTexts = await loadRecentImagePpvTexts(account.id);
      const caption = await generateImagePpvCaption({
        accountId: account.id,
        subscriberId: row.subscriber_id,
        fanExternalId: row.fan_external_id,
        fanDisplayName: realFirstName(row.display_name, row.fan_external_id),
        priceCents,
        impliedRegularPriceCents: impliedRegularCents,
        mode: "warm",
        recentTexts,
      });
      if (!caption) {
        result.skippedNoCaption++;
        continue;
      }

      const lockKey = imagePpvLockKey(account.id, row.fan_external_id);
      await sharedRedis().set(lockKey, "1", "EX", IMAGE_PPV_LOCK_TTL_SEC);

      const dryRunEffective = env.IMAGE_PPV_DRY_RUN;
      const entry: RecentImagePpv = {
        at: new Date().toISOString(),
        conversationId: convId,
        fanExternalId: row.fan_external_id,
        vaultImageId: imageId,
        priceCents,
        caption,
        dryRun: dryRunEffective,
      };
      RECENT_IMAGE_PPV.unshift(entry);
      if (RECENT_IMAGE_PPV.length > RECENT_IMAGE_PPV_MAX) RECENT_IMAGE_PPV.length = RECENT_IMAGE_PPV_MAX;

      if (dryRunEffective) {
        await sharedRedis().del(lockKey).catch(() => undefined);
        logger.info(entry, "image-ppv dry-run (no send)");
        result.sent++;
        continue;
      }

      try {
        const { id: messageId } = await insertOutboundDraft({
          conversationId: convId,
          text: caption,
          kind: "ppv",
          attachments: [{ assetRef: imageId, priceCents }],
        });
        await outboundQueue().add(
          "image-ppv",
          {
            accountId: account.id,
            conversationId: convId,
            subscriberId: row.subscriber_id,
            subscriberExternalId: row.fan_external_id,
            kind: "ppv",
            messageId,
            text: caption,
            ppv: { assetId: `vault:${imageId}`, assetRef: imageId, priceCents },
            bubbleIndex: 0,
            bubbleCount: 1,
          },
          { jobId: `image-ppv-${messageId}` },
        );
        await recordRecentImagePpvText(account.id, caption);
        await recordVaultImageSent(convId, imageId);
        logger.info(entry, "image-ppv enqueued");
        result.sent++;
      } catch (enqErr) {
        await sharedRedis().del(lockKey).catch(() => undefined);
        logger.warn(
          { err: enqErr instanceof Error ? enqErr.message : enqErr, fanExternalId: row.fan_external_id },
          "image-ppv enqueue failed — cooldown lock rolled back",
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, subscriberId: row.subscriber_id },
        "image-ppv send failed for one sub",
      );
    }
  }

  return result;
}

/**
 * Only pass a display name if it's plausibly a real first name (no digits /
 * handle). Mirrors the cold-tripwire guard.
 */
function realFirstName(name: string | null, externalId: string): string | null {
  if (!name) return null;
  const n = name.trim();
  if (n.length < 2 || n.length > 14) return null;
  if (/\d/.test(n)) return null;
  if (!/^[\p{L}][\p{L}\s'’-]*$/u.test(n)) return null;
  if (n.toLowerCase() === externalId.toLowerCase()) return null;
  return n;
}

export async function triggerImagePpvNow(): Promise<{ results: ImagePpvPassResult[] }> {
  const accounts = await allowlistedAccounts();
  const results: ImagePpvPassResult[] = [];
  for (const a of accounts) results.push(await runForAccount(a));
  return { results };
}

export interface ImagePpvWorkerHandle {
  stop: () => Promise<void>;
}

export function startImagePpvWorker(): ImagePpvWorkerHandle | null {
  if (!env.IMAGE_PPV_ENABLED) {
    logger.info("image-ppv worker disabled (IMAGE_PPV_ENABLED=false)");
    return null;
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const hourUtc = new Date().getUTCHours();
    if (!SEND_HOURS_UTC.has(hourUtc)) {
      logger.debug({ hourUtc }, "image-ppv tick skipped — outside send window");
      if (!stopped) timer = setTimeout(tick, TICK_MS);
      return;
    }
    try {
      const accounts = await allowlistedAccounts();
      const results: ImagePpvPassResult[] = [];
      for (const a of accounts) results.push(await runForAccount(a));
      const totalSent = results.reduce((s, r) => s + r.sent, 0);
      const totalCandidates = results.reduce((s, r) => s + r.candidates, 0);
      if (totalSent > 0 || totalCandidates > 0) {
        logger.info({ results, totalSent, totalCandidates }, "image-ppv tick");
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "image-ppv tick failed");
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_MS);
    }
  };

  timer = setTimeout(tick, STARTUP_DELAY_MS);
  logger.info(
    { tickMs: TICK_MS, dryRun: env.IMAGE_PPV_DRY_RUN, priceCents: env.IMAGE_PPV_PRICE_CENTS, maxPerTick: env.IMAGE_PPV_MAX_PER_TICK },
    "image-ppv worker started",
  );

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
