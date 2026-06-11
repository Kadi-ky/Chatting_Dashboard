import { sql, type SqlBool } from "kysely";
import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import { db } from "../db/client.js";
import { sharedRedis } from "../queue/redis.js";
import { outboundQueue } from "../queue/outbound.js";
import { insertOutboundDraft } from "../db/repos/messages.js";
import { isFanUnreachable } from "../platform/impl/http/unreachable.js";
import { isConversationDisengaged } from "./disengagement.js";
import { isConversationBotFlagged } from "./botDetection.js";
import { routeLlmCall } from "../llm/router.js";
import type { LlmMessage } from "../llm/types.js";
import { loadIdentityLayer } from "../prompt/layers/identity.js";
import { HUMANNESS_LAYER, HUMANNESS_VERSION } from "../prompt/layers/humanness.js";
import { CONTRACT_LAYER, CONTRACT_VERSION } from "../prompt/layers/contract.js";

/**
 * PPV reminder worker — ONE gentle reminder ~2h after a chat-pitched PPV goes
 * unanswered, once per attempt EVER. Built 2026-06-10 after the operator
 * removed the nudge worker (whose 6-step ladder felt like spam): 86 of 124
 * pitched PPVs expired in a 7d window with zero follow-up. This is the minimal
 * non-spammy middle ground — a single soft "still there for u" nudge at the
 * 2h mark, then never again for that attempt.
 *
 * Deliberately NARROW:
 *   - CHAT pitches only (asset_id without a source prefix). Mass-send
 *     attempts (voucher:/tripwire:/image:) are excluded — cold/quiet fans
 *     must not be chased (operator's hard-to-get directive).
 *   - Skipped entirely if the fan has messaged since the pitch — the live
 *     reply pipeline's close-focus already owns that conversation.
 *   - Once per attempt, enforced by a Redis NX key (14d TTL outlives the
 *     72h attempt-expiry sweep).
 *   - Full guard stack: disengaged / bot-flagged / disengage-keywords /
 *     unreachable / objection cooldown.
 */

const TICK_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 110_000;
const REMIND_AFTER_MS = 2 * 3600_000;   // remind 2h after pitch...
const REMIND_WINDOW_MAX_MS = 8 * 3600_000; // ...but not if the pitch is older than 8h (stale — let it expire)
const REMINDED_TTL_SEC = 14 * 24 * 3600;
const MAX_PER_TICK = 30;

const remindedKey = (attemptId: string): string => `peach:ppvremind:${attemptId}`;
const recentRingKey = (accountId: string): string => `peach:ppvremind:recent:${accountId}`;
const RECENT_RING_MAX = 12;
const RECENT_RING_TTL_SEC = 14 * 24 * 3600;

const FALLBACK_TEMPLATES = [
  "still got that one waiting for u babe, no rush 🖤",
  "ill keep it warm for u a lil longer",
  "that one's still sitting there lookin at u 👀",
];

// Same disengage patterns as the other proactive workers.
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

interface RecentReminder {
  at: string;
  conversationId: string;
  attemptId: string;
  fanExternalId: string;
  text: string;
}
const RECENT_REMINDERS: RecentReminder[] = [];
const RECENT_REMINDERS_MAX = 50;
export function getRecentPpvReminders(): RecentReminder[] {
  return RECENT_REMINDERS.slice();
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

async function generateReminderText(args: {
  accountId: string;
  subscriberId: string;
  fanDisplayName: string | null;
  recentTexts: string[];
}): Promise<string | null> {
  try {
    const identity = loadIdentityLayer(args.accountId);
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: [
          `# Identity`,
          identity,
          ``,
          `# Contract (v${CONTRACT_VERSION})`,
          CONTRACT_LAYER,
          ``,
          `# Humanness (v${HUMANNESS_VERSION})`,
          HUMANNESS_LAYER,
        ].join("\n"),
      },
      {
        role: "system",
        content: [
          `# Task — SINGLE PPV REMINDER (final, gentle)`,
          `~2 hours ago you sent this fan a locked PPV mid-conversation. He saw it and went quiet. Send ONE soft, zero-pressure reminder that it's still there. This is the ONLY reminder he will ever get for it — warm, confident, take-it-or-leave-it energy. NOT a hard close.`,
          ``,
          `RULES:`,
          `- ONE short message, 4-20 words. Casual texting voice, in character.`,
          `- NO price mention, no "unlock now", no urgency countdown, no begging, no "please".`,
          `- A light tease or "no rush" warmth works best.`,
          ...(args.recentTexts.length > 0
            ? [
                ``,
                `RECENT REMINDERS YOU'VE SENT OTHER FANS — do not repeat their shape or wording:`,
                ...args.recentTexts.slice(0, 8).map((t, i) => `  ${i + 1}. ${t}`),
              ]
            : []),
          ``,
          `OUTPUT FORMAT — STRICT JSON: {"text": "the message"}`,
        ].join("\n"),
      },
    ];
    const result = await routeLlmCall({
      task: "NUDGE_GENERATE",
      messages,
      maxTokens: 120,
      temperature: 0.9,
      responseFormat: "json_object",
      meta: { accountId: args.accountId, subscriberId: args.subscriberId, kind: "ppv_reminder" },
    });
    let text: string | null = null;
    try {
      const obj = JSON.parse(result.content.trim()) as Record<string, unknown>;
      if (typeof obj.text === "string") text = obj.text.trim();
    } catch {
      /* fall through to null */
    }
    if (!text || text.length < 3 || text.length > 200) return null;
    if (/[{}<>]|\\n|\bjson\b/i.test(text)) return null; // residue guard
    return text;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "ppv reminder generation failed");
    return null;
  }
}

interface ReminderPassResult {
  candidates: number;
  sent: number;
  skippedGuards: number;
  skippedAlreadyReminded: number;
}

export async function runPpvReminderPass(): Promise<ReminderPassResult> {
  const now = Date.now();
  const remindBefore = new Date(now - REMIND_AFTER_MS);   // pitched ≥2h ago
  const remindAfter = new Date(now - REMIND_WINDOW_MAX_MS); // pitched ≤8h ago

  const rows = await db
    .selectFrom("v3.ppv_attempts as a")
    .innerJoin("v3.conversations as c", "c.id", "a.conversation_id")
    .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
    .innerJoin("v3.accounts as acc", "acc.id", "c.account_id")
    .select([
      "a.id as attempt_id",
      "a.pitched_at as pitched_at",
      "c.id as conv_id",
      "c.account_id as account_id",
      "s.id as subscriber_id",
      "s.external_id as fan_external_id",
      "s.display_name as display_name",
      "s.last_inbound_at as last_inbound_at",
      "acc.platform_account_id as platform_account_id",
    ])
    .where("a.outcome", "=", "pending")
    .where(sql<SqlBool>`a.pitched_at < ${remindBefore}`)
    .where(sql<SqlBool>`a.pitched_at > ${remindAfter}`)
    // Chat pitches only — mass-send attempts carry a "source:" prefix.
    .where(sql<SqlBool>`a.asset_id NOT LIKE '%:%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'loop-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'longtime-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE '%-probe-%'`)
    .orderBy("a.pitched_at", "desc")
    .limit(100)
    .execute();

  const result: ReminderPassResult = { candidates: rows.length, sent: 0, skippedGuards: 0, skippedAlreadyReminded: 0 };
  const r = sharedRedis();

  for (const row of rows) {
    if (result.sent >= MAX_PER_TICK) break;
    try {
      const convId = row.conv_id as string;

      // If the fan messaged AFTER the pitch, the live conversation (close-
      // focus) owns it — a parallel reminder would double-team him.
      const lastInbound = row.last_inbound_at ? new Date(row.last_inbound_at as unknown as Date).getTime() : 0;
      const pitchedAt = new Date(row.pitched_at as unknown as Date).getTime();
      if (lastInbound > pitchedAt) {
        result.skippedGuards++;
        continue;
      }

      // Once per attempt, ever — NX claim. Permanent-ish guard skips
      // (disengaged 14d / bot-flag / disengage keywords / unreachable 30d)
      // deliberately KEEP the claim: those fans shouldn't be re-evaluated
      // every tick. Only transient failures (objection cooldown 6h, enqueue
      // error) roll the claim back so the attempt gets one more shot.
      const claimed = await r.set(remindedKey(row.attempt_id as string), "1", "EX", REMINDED_TTL_SEC, "NX");
      if (claimed !== "OK") {
        result.skippedAlreadyReminded++;
        continue;
      }

      const rollback = async (): Promise<void> => {
        await r.del(remindedKey(row.attempt_id as string)).catch(() => undefined);
      };

      if (await isConversationDisengaged(convId)) { result.skippedGuards++; continue; }
      if (await isConversationBotFlagged(convId)) { result.skippedGuards++; continue; }
      const objCooldown = await r.get(`peach:objection:cooldown:${convId}`).catch(() => null);
      if (objCooldown) { await rollback(); result.skippedGuards++; continue; }
      if (await fanIsDisengaging(convId)) { result.skippedGuards++; continue; }
      if (row.platform_account_id && (await isFanUnreachable(row.platform_account_id as string, row.fan_external_id as string))) {
        result.skippedGuards++;
        continue;
      }

      const recentTexts = await r.lrange(recentRingKey(row.account_id as string), 0, RECENT_RING_MAX - 1).catch(() => [] as string[]);
      const llmText = await generateReminderText({
        accountId: row.account_id as string,
        subscriberId: row.subscriber_id as string,
        fanDisplayName: row.display_name as string | null,
        recentTexts,
      });
      const text = llmText ?? FALLBACK_TEMPLATES[Math.floor(Math.random() * FALLBACK_TEMPLATES.length)]!;

      try {
        const { id: messageId } = await insertOutboundDraft({
          conversationId: convId,
          text,
          kind: "text",
        });
        await outboundQueue().add(
          "ppv-reminder",
          {
            accountId: row.account_id as string,
            conversationId: convId,
            subscriberId: row.subscriber_id as string,
            subscriberExternalId: row.fan_external_id as string,
            kind: "text",
            messageId,
            text,
            bubbleIndex: 0,
            bubbleCount: 1,
          },
          { jobId: `ppvremind-${messageId}` },
        );
        await r.lpush(recentRingKey(row.account_id as string), text).catch(() => undefined);
        await r.ltrim(recentRingKey(row.account_id as string), 0, RECENT_RING_MAX - 1).catch(() => undefined);
        await r.expire(recentRingKey(row.account_id as string), RECENT_RING_TTL_SEC).catch(() => undefined);

        const entry: RecentReminder = {
          at: new Date().toISOString(),
          conversationId: convId,
          attemptId: row.attempt_id as string,
          fanExternalId: row.fan_external_id as string,
          text,
        };
        RECENT_REMINDERS.unshift(entry);
        if (RECENT_REMINDERS.length > RECENT_REMINDERS_MAX) RECENT_REMINDERS.length = RECENT_REMINDERS_MAX;
        logger.info(entry, "ppv reminder enqueued");
        result.sent++;
      } catch (enqErr) {
        await rollback(); // let a transient enqueue failure retry next tick
        logger.warn(
          { err: enqErr instanceof Error ? enqErr.message : enqErr, convId },
          "ppv reminder enqueue failed — claim rolled back",
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, attemptId: row.attempt_id },
        "ppv reminder failed for one attempt",
      );
    }
  }

  if (result.sent > 0) logger.info(result, "ppv reminder pass");
  return result;
}

export async function triggerPpvReminderNow(): Promise<ReminderPassResult> {
  return runPpvReminderPass();
}

export interface PpvReminderWorkerHandle {
  stop: () => Promise<void>;
}

export function startPpvReminderWorker(): PpvReminderWorkerHandle | null {
  if (!env.PPV_REMINDER_ENABLED) {
    logger.info("ppv reminder worker disabled (PPV_REMINDER_ENABLED=false)");
    return null;
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runPpvReminderPass();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "ppv reminder tick failed");
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_MS);
    }
  };

  timer = setTimeout(tick, STARTUP_DELAY_MS);
  logger.info({ tickMs: TICK_MS }, "ppv reminder worker started");

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
