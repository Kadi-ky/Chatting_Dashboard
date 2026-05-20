import { sql, type SqlBool } from "kysely";
import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import { db } from "../db/client.js";
import { outboundQueue } from "../queue/outbound.js";
import { sharedRedis } from "../queue/redis.js";
import { insertOutboundDraft, loadRecentMessages } from "../db/repos/messages.js";
import { loadLatestArchetype } from "../db/repos/archetypes.js";
import { isConversationDisengaged } from "./disengagement.js";
import { loadIdentityLayer } from "../prompt/layers/identity.js";
import { HUMANNESS_LAYER, HUMANNESS_VERSION } from "../prompt/layers/humanness.js";
import { CONTRACT_LAYER, CONTRACT_VERSION } from "../prompt/layers/contract.js";
import { routeLlmCall } from "../llm/router.js";
import type { LlmMessage } from "../llm/types.js";

/**
 * Auto-nudge worker.
 *
 * Two passes, both running in the same tick (every NUDGE_TICK_MS):
 *
 *   1. IDLE FAN re-engagement
 *      - Fan stopped replying after a normal exchange
 *      - Ladder (cumulative from last fan inbound):
 *        30 min → 2 h → 6 h → 24 h → 3 d → 7 d
 *      - Capped at 6 nudges. After step 6 (7 days), NO further nudges
 *        until the fan sends a new inbound (which resets the counter
 *        via clearIdleNudgeState, called from conversationWorker on
 *        every message.received).
 *
 *   2. PPV nudge after no-buy
 *      - Bot pitched a PPV, fan didn't unlock and didn't reply
 *      - First nudge after 30 min unbought, second after 2 h, then stop
 *
 * Defaults are conservative; tune via env vars without redeploying.
 *
 * SAFETY:
 *   - NUDGE_ENABLED defaults false (master kill switch)
 *   - NUDGE_DRY_RUN logs would-send without enqueueing outbound jobs
 *   - Each nudge goes through the existing send pipeline (token bucket +
 *     conversation gap), so nudges can't trigger 429 storms
 *   - Disengagement / "stop" / "leave me alone" detected via simple keyword
 *     check on the most recent fan inbound; those convos are skipped
 *
 * STATE STORAGE:
 *   conversations.state_ctx jsonb is reused (no schema change). Shape:
 *     {
 *       ...existing keys,
 *       nudge: {
 *         idleCount: 0|1|2|3,
 *         lastIdleAt: "<iso>",
 *         ppvNudges: { "<attempt_id>": count }
 *       }
 *     }
 */

const NUDGE_TICK_MS = 5 * 60_000;
const NUDGE_STARTUP_DELAY_MS = 30_000;

// Idle fan re-engagement ladder (ms since fan's LAST INBOUND — cumulative,
// not interval). Operator spec 2026-04-30: extended to 6 steps with a
// long tail. After the 6th nudge, no further attempts until the fan
// replies (which clearIdleNudgeState resets to fresh ladder).
const IDLE_LADDER_MS = [
  30 * 60_000,            // 1st: 30 min
  2 * 60 * 60_000,        // 2nd: 2 hours
  6 * 60 * 60_000,        // 3rd: 6 hours
  24 * 60 * 60_000,       // 4th: 24 hours (1 day)
  3 * 24 * 60 * 60_000,   // 5th: 3 days
  7 * 24 * 60 * 60_000,   // 6th + final: 7 days
];

const IDLE_TEMPLATES: string[][] = [
  // Step 1 (30 min) — light, casual check-in
  ["hey u still around babe? 🥺", "u disappear on me lol", "where u been hiding 😏"],
  // Step 2 (2 h) — slightly more deliberate
  ["miss u babe, hope ur day's been good 🖤", "u been mia, hit me up when u can babe", "hey daddy, u still got me on ur mind?"],
  // Step 3 (6 h) — warm + a little vulnerable
  ["still thinkin bout u babe, come back soon 🥺", "lowkey missin our convo today 🖤", "hey papi, dms feel empty without u"],
  // Step 4 (24 h) — explicit "miss you" energy
  ["been a whole day babe, u good? 🥺", "havent heard from u since yesterday, miss that energy", "hey hun, u alive? 💕"],
  // Step 5 (3 days) — last try at warm pull
  ["hey stranger, where'd u go babe 🖤", "been thinkin bout u all week, come back when u can", "hey daddy, hope life's bein good to u"],
  // Step 6 (7 days, FINAL) — door-open farewell, no follow-up after
  ["hope ur doin good babe, dms open whenever u feel like it 🖤", "alright papi, ill stop sliding into ur dms — but if u ever wanna catch up, im here"],
];

// PPV no-buy nudge (ms since the PPV was pitched).
const PPV_NUDGE_THRESHOLDS_MS = [
  30 * 60_000, // 1st PPV nudge after 30 min
  2 * 60 * 60_000, // 2nd PPV nudge after 2 h
];
const PPV_TEMPLATES: string[][] = [
  ["did u see what i sent babe?", "u still thinkin about it?", "lmk if ur still around"],
  ["last call on that one, lemme know", "ill keep it warm for u for a bit longer"],
];

// Cheap unsubscribe / disengagement detection — never nudge fans whose recent
// inbound contains any of these. Cuts ~all of the bad-vibe nudge cases.
/**
 * Disengagement signals — if any of these match the fan's last 3 inbound
 * messages, skip nudging. Operator audit 2026-05-08: hessu was getting
 * spam-nudged across all 6 ladder steps after saying "Sorry but really
 * i am out of money" + "Yeah i will" because none of the explicit
 * patterns ("stop", "leave me alone", "unsub") matched. Real fans almost
 * never say those things — they politely deflect or admit money issues.
 *
 * Three buckets:
 *   1. Explicit refusal — the original list (stop / leave me alone / etc).
 *   2. Economic disengagement — fan said they can't pay. Continuing to
 *      nudge after this reads as guilt-trip / harassment and burns a fan
 *      who would have come back later on their own.
 *   3. Polite blow-offs — "ill think about it" / "maybe later" / "save up".
 *      Often a soft no the fan won't escalate to a hard no but bot pinging
 *      every few hours pushes them to it.
 */
const DISENGAGE_PATTERNS = [
  // (1) Explicit refusal
  /\bstop\b/i,
  /\bleave me alone\b/i,
  /\bunsub/i,
  /\bbug(?:ging)? off\b/i,
  /\bblock(?:ed|ing)?\b/i,
  /\bgoodbye\b/i,
  /\bbye for good\b/i,
  /\bnot interested\b/i,
  // (2) Economic disengagement
  /\b(?:out of|no|low on|short on) (?:money|cash|funds)\b/i,
  /\b(?:cant?|can'?t|cannot)\s+afford\b/i,
  /\b(?:im|i am|i'?m)\s+broke\b/i,
  /\b(?:money|funds?|cash)\s+(?:so|too|are|is)?\s*low\b/i,
  /\bnext (?:paycheck|payday|paydate|check)\b/i,
  /\bsave\s+up\b/i,
  /\bbroke\s+(?:rn|right now|atm|af)\b/i,
  // (3) Polite blow-offs — calibrated tight to avoid false positives
  /\b(?:maybe|talk)\s+later\b/i,
  /\bi(?:'?ll|ll)\s+(?:think|let u know|get back|see)\b/i,
  /\b(?:ill|i will)\s+see\b/i,
  /\bgotta (?:go|run|head)\b/i,
  /\b(?:gtg|brb)\b/i,
  /\bbusy (?:rn|right now|atm)\b/i,
];

interface NudgeState {
  idleCount?: number;
  lastIdleAt?: string;
  ppvNudges?: Record<string, number>;
}

/**
 * Redis-backed CONVERSATION-WIDE nudge lock. Single key per conv, both
 * idle and ppv passes share it. Operator observed 2026-04-29 dry-run:
 * the same conversation got an idle nudge AND a ppv nudge 2 seconds
 * apart because the previous lock had separate keys per kind. That
 * would be spam in live mode. Fix: one lock per conv per 25 min,
 * regardless of which ladder triggered.
 *
 * TTL is 25 min — slightly less than the smallest ladder threshold (30 min)
 * so legitimate ladder progression isn't blocked. Fail-CLOSED on Redis
 * errors: if we can't acquire the lock, we don't fire (better silent than
 * spamming).
 */
// Lock TTL must cover the LARGEST gap in the ladder + a safety margin
// so state_ctx write failures can't allow a re-fire within an earlier
// step's window. With 30m / 2h / 6h / 24h / 3d / 7d ladder, max gap
// at the end is 4 days (7d - 3d). But we use a SHORTER lock per step:
// the lock is just the floor preventing duplicate fires WITHIN a tick
// (or within a deploy storm). State_ctx tracks the actual ladder
// progression. So 12h is enough — covers any per-step lock need
// without blocking legitimate later-step fires.
// The lock is cleared on fan inbound (clearIdleNudgeState).
const NUDGE_LOCK_TTL_SEC = 12 * 3600; // 12h
const nudgeLockKey = (convId: string): string => `peach:nudge:lock:any:${convId}`;

async function tryAcquireNudgeLock(convId: string): Promise<boolean> {
  try {
    const result = await sharedRedis().set(
      nudgeLockKey(convId),
      "1",
      "EX",
      NUDGE_LOCK_TTL_SEC,
      "NX",
    );
    return result === "OK";
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, convId },
      "nudge lock acquire failed — failing closed (no fire this tick)",
    );
    return false;
  }
}

/**
 * Per-(account, fan) recent-nudge dedup ring. Mirrors the mass-caption
 * pattern: keeps the last 10 nudge texts per fan in Redis so the LLM can
 * be told "DO NOT repeat these themes/phrasing" — prevents the
 * "Hey babe, still lmao at that PC-133 ram" issue where step 1 and step 2
 * came out nearly identical because the prompt context was the same.
 */
const RECENT_NUDGE_TEXT_TTL_SEC = 14 * 24 * 3600; // 14 days
const RECENT_NUDGE_TEXT_MAX = 10;
const recentNudgeTextsKey = (accountId: string, conversationId: string): string =>
  `peach:nudge:recent:${accountId}:${conversationId}`;

async function loadRecentNudgeTexts(accountId: string, conversationId: string): Promise<string[]> {
  try {
    return await sharedRedis().lrange(
      recentNudgeTextsKey(accountId, conversationId),
      0,
      RECENT_NUDGE_TEXT_MAX - 1,
    );
  } catch {
    return [];
  }
}

async function recordRecentNudgeText(
  accountId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    const r = sharedRedis();
    const k = recentNudgeTextsKey(accountId, conversationId);
    await r.lpush(k, text);
    await r.ltrim(k, 0, RECENT_NUDGE_TEXT_MAX - 1);
    await r.expire(k, RECENT_NUDGE_TEXT_TTL_SEC);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, accountId, conversationId },
      "failed to record recent nudge text (nudge sent regardless)",
    );
  }
}

interface RecentNudge {
  at: string;
  conversationId: string;
  fanExternalId: string;
  kind: "idle" | "ppv";
  step: number;
  text: string;
  dryRun: boolean;
}
const RECENT_NUDGES: RecentNudge[] = [];
const RECENT_NUDGES_MAX = 50;
export function getRecentNudges(): RecentNudge[] {
  return RECENT_NUDGES.slice();
}

export interface NudgeWorkerHandle {
  stop: () => Promise<void>;
}

export function startNudgeWorker(): NudgeWorkerHandle | null {
  if (!env.NUDGE_ENABLED) {
    logger.info("nudge worker disabled (NUDGE_ENABLED=false)");
    return null;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runNudgePass();
      if (result.idleCandidates > 0 || result.ppvCandidates > 0) {
        logger.info(result, "nudge tick");
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "nudge tick failed",
      );
    } finally {
      if (!stopped) timer = setTimeout(tick, NUDGE_TICK_MS);
    }
  };

  timer = setTimeout(tick, NUDGE_STARTUP_DELAY_MS);
  logger.info(
    { tickMs: NUDGE_TICK_MS, dryRun: env.NUDGE_DRY_RUN },
    "nudge worker started",
  );

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function runNudgePass(): Promise<{
  idleCandidates: number;
  idleSent: number;
  ppvCandidates: number;
  ppvSent: number;
}> {
  const idleResult = await runIdlePass();
  const ppvResult = await runPpvPass();
  return {
    idleCandidates: idleResult.candidates,
    idleSent: idleResult.sent,
    ppvCandidates: ppvResult.candidates,
    ppvSent: ppvResult.sent,
  };
}

// ─── IDLE PASS ────────────────────────────────────────────────────────────

async function runIdlePass(): Promise<{ candidates: number; sent: number }> {
  // Find conversations whose last activity was outbound > 30 min ago AND not
  // already exhausted on the nudge ladder. We re-evaluate the exact ladder
  // step + state inside the loop.
  const cutoff = new Date(Date.now() - IDLE_LADDER_MS[0]!);
  const rows = await db
    .selectFrom("v3.conversations as c")
    .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
    .innerJoin("v3.accounts as a", "a.id", "c.account_id")
    .select([
      "c.id as conv_id",
      "c.account_id as account_id",
      "c.last_activity_at as last_activity_at",
      "c.state_ctx as state_ctx",
      "s.id as subscriber_id",
      "s.external_id as fan_external_id",
    ])
    .where(sql<SqlBool>`c.last_activity_at < ${cutoff}`)
    // Only nudge accounts that the operator actually wants live (allowlist
    // already gates webhook ingress; double-check at nudge time too).
    .where("a.platform_account_id", "is not", null)
    // Skip synthetic test conversations from the V3 testing harness
    // (loop-freebie_hunter-..., loop-time_waster-..., etc.). Those have
    // synthetic fan ids that aren't real OF users — nudging them is just
    // log noise.
    .where(sql<SqlBool>`s.external_id NOT LIKE 'loop-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'longtime-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE '%-probe-%'`)
    .orderBy("c.last_activity_at", "desc")
    .limit(200)
    .execute();

  let sent = 0;
  for (const row of rows) {
    try {
      const lastInbound = await getLastInboundAt(row.conv_id);
      if (!lastInbound) continue;
      const lastInboundMs = lastInbound.getTime();
      const sinceInbound = Date.now() - lastInboundMs;

      // Determine which step on the ladder we're due for, given state.
      const state = readNudgeState(row.state_ctx);
      const idleCount = state.idleCount ?? 0;
      if (idleCount >= IDLE_LADDER_MS.length) continue; // ladder exhausted

      const requiredMs = IDLE_LADDER_MS[idleCount]!;
      if (sinceInbound < requiredMs) continue;

      // Don't nudge if we already nudged within the ladder step (race-safe).
      if (state.lastIdleAt) {
        const sinceLastNudge = Date.now() - new Date(state.lastIdleAt).getTime();
        if (sinceLastNudge < requiredMs) continue;
      }

      // Sticky disengagement flag (set by conversationWorker on explicit
      // refusal). Survives past the 3-inbound window of fanIsDisengaging
      // — checked first because it's the cheapest gate.
      if (await isConversationDisengaged(row.conv_id)) continue;
      // Skip if the most recent inbound text contains disengagement signals.
      if (await fanIsDisengaging(row.conv_id)) continue;

      // Hard rate limit floor — single conv-wide lock for both idle + ppv
      // (operator observed dry-run firing both kinds 2s apart on same conv
      // when locks were per-kind). Lock = 25 min TTL.
      if (!(await tryAcquireNudgeLock(row.conv_id))) {
        logger.debug({ convId: row.conv_id }, "idle nudge lock held — skipping");
        continue;
      }

      // Generate the nudge with the LLM, conversation-context-aware. Falls
      // back to a random pick from the static template pool only if the LLM
      // call fails (network blip, model overloaded, etc.) so we never go
      // silent on a fan who's due for a nudge.
      const step = idleCount;
      const llmText = await generateNudgeText({
        conversationId: row.conv_id,
        accountId: row.account_id,
        subscriberId: row.subscriber_id,
        kind: "idle",
        step,
      });
      const variants = IDLE_TEMPLATES[step]!;
      const text = llmText ?? variants[Math.floor(Math.random() * variants.length)]!;

      await sendNudge({
        conversationId: row.conv_id,
        accountId: row.account_id,
        subscriberId: row.subscriber_id,
        fanExternalId: row.fan_external_id,
        text,
        kind: "idle",
        step: step + 1,
      });
      await writeNudgeState(row.conv_id, {
        ...state,
        idleCount: idleCount + 1,
        lastIdleAt: new Date().toISOString(),
      });
      sent++;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, convId: row.conv_id },
        "idle nudge failed",
      );
    }
  }
  return { candidates: rows.length, sent };
}

// ─── PPV PASS ─────────────────────────────────────────────────────────────

async function runPpvPass(): Promise<{ candidates: number; sent: number }> {
  // Find pending ppv_attempts pitched > 30 min ago and not yet maxed out on
  // PPV-nudge count. The cap (2) lives in PPV_NUDGE_THRESHOLDS_MS.length.
  const cutoff = new Date(Date.now() - PPV_NUDGE_THRESHOLDS_MS[0]!);
  const rows = await db
    .selectFrom("v3.ppv_attempts as a")
    .innerJoin("v3.conversations as c", "c.id", "a.conversation_id")
    .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
    .select([
      "a.id as attempt_id",
      "a.pitched_at as pitched_at",
      "c.id as conv_id",
      "c.account_id as account_id",
      "c.state_ctx as state_ctx",
      "s.id as subscriber_id",
      "s.external_id as fan_external_id",
    ])
    .where("a.outcome", "=", "pending")
    .where(sql<SqlBool>`a.pitched_at < ${cutoff}`)
    // Skip synthetic test conversations (loop-* fan ids).
    .where(sql<SqlBool>`s.external_id NOT LIKE 'loop-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'longtime-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE '%-probe-%'`)
    .orderBy("a.pitched_at", "desc")
    .limit(100)
    .execute();

  let sent = 0;
  for (const row of rows) {
    try {
      const state = readNudgeState(row.state_ctx);
      const ppvNudges = state.ppvNudges ?? {};
      const attemptCount = ppvNudges[row.attempt_id] ?? 0;
      if (attemptCount >= PPV_NUDGE_THRESHOLDS_MS.length) continue;

      const sincePitch =
        Date.now() - (row.pitched_at as unknown as Date).getTime();
      const requiredMs = PPV_NUDGE_THRESHOLDS_MS[attemptCount]!;
      if (sincePitch < requiredMs) continue;

      // Sticky disengagement flag — set by conversationWorker on explicit "no".
      if (await isConversationDisengaged(row.conv_id)) continue;
      // Skip if disengaged
      if (await fanIsDisengaging(row.conv_id)) continue;

      // Hard rate limit floor (same conv-wide lock as idle pass).
      if (!(await tryAcquireNudgeLock(row.conv_id))) {
        logger.debug({ convId: row.conv_id }, "ppv nudge lock held — skipping");
        continue;
      }

      // LLM-generate a context-aware nudge; templates are the safety net.
      const llmText = await generateNudgeText({
        conversationId: row.conv_id,
        accountId: row.account_id,
        subscriberId: row.subscriber_id,
        kind: "ppv",
        step: attemptCount,
      });
      const variants = PPV_TEMPLATES[attemptCount]!;
      const text = llmText ?? variants[Math.floor(Math.random() * variants.length)]!;

      await sendNudge({
        conversationId: row.conv_id,
        accountId: row.account_id,
        subscriberId: row.subscriber_id,
        fanExternalId: row.fan_external_id,
        text,
        kind: "ppv",
        step: attemptCount + 1,
      });
      await writeNudgeState(row.conv_id, {
        ...state,
        ppvNudges: { ...ppvNudges, [row.attempt_id]: attemptCount + 1 },
      });
      sent++;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, attemptId: row.attempt_id },
        "ppv nudge failed",
      );
    }
  }
  return { candidates: rows.length, sent };
}

// ─── helpers ──────────────────────────────────────────────────────────────

function readNudgeState(stateCtx: unknown): NudgeState {
  if (!stateCtx || typeof stateCtx !== "object") return {};
  const obj = stateCtx as Record<string, unknown>;
  const n = obj.nudge;
  if (!n || typeof n !== "object") return {};
  return n as NudgeState;
}

async function writeNudgeState(convId: string, next: NudgeState): Promise<void> {
  // Merge into state_ctx without clobbering other keys. Postgres jsonb_set
  // is the cleanest atomic-ish way; we just go with a json_build approach.
  await sql`
    UPDATE v3.conversations
    SET state_ctx = jsonb_set(coalesce(state_ctx, '{}'::jsonb), '{nudge}', ${JSON.stringify(next)}::jsonb, true)
    WHERE id = ${convId}
  `.execute(db);
}

/**
 * Reset the idle-nudge counter on a conversation. Called from
 * conversationWorker when a new fan inbound arrives — gives the fan a fresh
 * 3-nudge ladder for the next time they go silent. We DO NOT touch
 * ppvNudges (those are keyed per ppv_attempt and naturally retire when
 * the attempt resolves).
 *
 * Two operations:
 *   1. jsonb_set state_ctx.nudge.idleCount to 0 + lastIdleAt to null.
 *   2. DELETE the Redis lock key (peach:nudge:lock:any:<convId>) so
 *      legitimate post-reply nudge cycles aren't blocked by the long
 *      lock TTL (6h30m — sized for ladder gap, not state-reset).
 */
export async function clearIdleNudgeState(convId: string): Promise<void> {
  await Promise.all([
    sql`
      UPDATE v3.conversations
      SET state_ctx = jsonb_set(
        jsonb_set(
          coalesce(state_ctx, '{}'::jsonb),
          '{nudge,idleCount}',
          '0'::jsonb,
          true
        ),
        '{nudge,lastIdleAt}',
        'null'::jsonb,
        true
      )
      WHERE id = ${convId}
    `.execute(db),
    // Drop the conv-wide nudge lock; if the fan went silent again, the
    // ladder starts fresh from step 1 instead of being blocked for 6+ hours.
    sharedRedis().del(nudgeLockKey(convId)).catch(() => undefined),
  ]);
}

async function getLastInboundAt(convId: string): Promise<Date | null> {
  const row = await db
    .selectFrom("v3.messages")
    .select("created_at")
    .where("conversation_id", "=", convId)
    .where("direction", "=", "inbound")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return (row?.created_at as unknown as Date) ?? null;
}

async function fanIsDisengaging(convId: string): Promise<boolean> {
  const recent = await db
    .selectFrom("v3.messages")
    .select("text")
    .where("conversation_id", "=", convId)
    .where("direction", "=", "inbound")
    .orderBy("created_at", "desc")
    .limit(3)
    .execute();
  for (const r of recent) {
    const t = r.text ?? "";
    if (DISENGAGE_PATTERNS.some((p) => p.test(t))) return true;
  }
  return false;
}

interface SendNudgeArgs {
  conversationId: string;
  accountId: string;
  subscriberId: string;
  fanExternalId: string;
  text: string;
  kind: "idle" | "ppv";
  step: number;
}

/**
 * Step-specific tone guidance for the nudge generator. Simple openers are
 * VALID — operator-observed 2026-04-30 that forced specific-word hooks
 * produced the same templated shape every nudge ("ur 'this' had me laughin
 * all day babe..."). Real chatters often just say "hey u still here baby".
 * Allow that shape; reference only when it lands naturally.
 */
const NUDGE_STEP_OBJECTIVES = {
  idle: [
    "STEP 1 (30 min after he went silent) — light, casual check-in. He hasn't been gone long. Simple openers are FINE here ('u still around babe', 'where'd u go', 'hey baby u up'). Or reference his last messages if it lands naturally. Tone: warm, curious, not clingy. ONE short bubble, can be 4-18 words. Emoji optional.",
    "STEP 2 (2 hours after silence) — slightly more deliberate. Can be specific or general ('been thinkin bout u'). Light tease ok. ONE bubble, 4-22 words. Emoji optional.",
    "STEP 3 (6 hours) — warm and a little vulnerable. Vibe is 'i miss the energy we had' or just 'where'd u go'. ONE bubble, 4-25 words. Emoji optional.",
    "STEP 4 (24 hours / 1 day) — explicit 'miss u' energy. Note it's been a day, ask if he's good. Slightly needy ok. ONE bubble, 4-25 words. Emoji optional (🥺 / 🖤 fit here if any).",
    "STEP 5 (3 days) — last warm pull. Tone is 'i still think about u, hope ur well'. NOT begging. ONE bubble, 4-25 words. Emoji optional.",
    "STEP 6 (7 days, FINAL — no follow-up after this) — door-open farewell. Vibe: 'i'll stop coming after u, but my dms are always open'. NOT cold goodbye. ONE bubble, 4-28 words. Emoji optional.",
  ],
  ppv: [
    "STEP 1 (30 min after the priced PPV went unanswered) — soft check on whether he saw it. Simple is fine ('u still thinkin babe?'); reference is fine when natural. NOT pushy. ONE bubble, 4-18 words. Emoji optional.",
    "STEP 2 (2 hours, FINAL PPV nudge) — last call, warm. Hold the door open without begging. ONE bubble, 4-22 words. Emoji optional.",
  ],
} as const;

/**
 * Build the LLM nudge generator prompt and call it. Returns the generated
 * caption on success, null on any failure (caller falls back to the static
 * template pool). Layered like the chat generator so nudges read in the same
 * v1.8 pick-me voice as everything else, but instructed to output a single
 * plain-text bubble rather than the chat generator's JSON envelope.
 */
async function generateNudgeText(args: {
  conversationId: string;
  accountId: string;
  subscriberId: string;
  kind: "idle" | "ppv";
  step: number; // 0-indexed
}): Promise<string | null> {
  const stepObjective =
    NUDGE_STEP_OBJECTIVES[args.kind][args.step] ?? NUDGE_STEP_OBJECTIVES[args.kind][0]!;
  try {
    const [history, archetype] = await Promise.all([
      loadRecentMessages(args.conversationId, 10),
      loadLatestArchetype(args.subscriberId),
    ]);
    const identity = loadIdentityLayer(args.accountId);

    // Reuse the same persona + contract + humanness prefix as the chat
    // generator so voice is consistent. Cache prefix lands first; volatile
    // bits follow as separate system messages.
    const prefix = [
      `# Identity`,
      identity,
      ``,
      `# Contract (v${CONTRACT_VERSION})`,
      CONTRACT_LAYER,
      ``,
      `# Humanness (v${HUMANNESS_VERSION})`,
      HUMANNESS_LAYER,
    ].join("\n");

    const messages: LlmMessage[] = [{ role: "system", content: prefix }];

    if (archetype) {
      const facts: string[] = [];
      if (archetype.spenderTier) facts.push(`spender tier: ${archetype.spenderTier}`);
      if (archetype.engagementLevel) facts.push(`engagement: ${archetype.engagementLevel}`);
      if (archetype.relationshipTone) facts.push(`tone: ${archetype.relationshipTone}`);
      if (archetype.fetishTags?.length) facts.push(`interests: ${archetype.fetishTags.join(", ")}`);
      if (facts.length > 0) {
        messages.push({
          role: "system",
          content: `# Known facts about this fan\n${facts.map((f) => `- ${f}`).join("\n")}`,
        });
      }
    }

    if (history.length > 0) {
      // Most recent N messages, oldest first, labelled. Lets the model
      // see the conversation arc and pick a hook.
      const transcript = history
        .filter((m) => (m.direction === "inbound" || m.direction === "outbound") && m.text)
        .slice(-10)
        .map((m) => `${m.direction === "inbound" ? "FAN" : "YOU"}: ${m.text}`)
        .join("\n");
      messages.push({
        role: "system",
        content: `# Recent conversation (most recent at the bottom)\n${transcript}`,
      });
    }

    // Per-fan recent-nudge dedup. Without this, step 1 and step 2 nudges to
    // the same conversation get nearly identical text because the LLM is
    // seeded with the same context. Feeding the last 10 sent texts as a
    // "do-not-repeat" list breaks the loop.
    const recentTexts = await loadRecentNudgeTexts(args.accountId, args.conversationId);

    messages.push({
      role: "system",
      content: [
        `# Task — auto-nudge re-engagement`,
        `Fan went silent after the conversation above. You are sending an UNPROMPTED follow-up message to pull him back in.`,
        ``,
        stepObjective,
        ``,
        `HARD REQUIREMENTS:`,
        `- Reference something specific from the transcript WHEN it lands naturally. Simple openers ("u still around baby", "where'd u go", "hey baby u up") are also fine — especially ladder step 4+ or when his last messages give nothing concrete to anchor on. Forced hooks that paraphrase his exact word back read as bot.`,
        `- Match the active humanness layer voice (above). Warm, attentive.`,
        `- ONE short message only.`,
        `- No mention of price, no PPV pitch, no "unlock". This is rapport repair, not selling.`,
        `- No begging, no "please". Confident warmth.`,
        ``,
        ...(recentTexts.length > 0
          ? [
              `RECENT SENDS to this same fan — DO NOT repeat the angle, opener, or phrasing of any of these. CRITICAL: also rotate the THEME/topic. If 2+ of the recent sends mention the same callback (e.g. his job, a pet, a content asset he hasn't bought), STOP using that callback and pick a different angle (a different memory from earlier in the convo, an observation about the time of day, a genuine "thinkin bout u" with no topic anchor). Operator audit 2026-05-08: same-theme nudges 5+ times in a row read as bot lock-in.`,
              ...recentTexts.slice(0, 6).map((t, i) => `  ${i + 1}. ${t}`),
              ``,
            ]
          : []),
        `OUTPUT FORMAT — STRICT JSON. Return a single JSON object exactly like:`,
        `  {"nudge": "the actual nudge text here"}`,
        `Rules:`,
        `- Do NOT wrap in markdown code fences.`,
        `- Do NOT include any prose before or after the JSON.`,
        `- Do NOT use placeholder values like "text here" or wrapped in <...> / [...].`,
      ].join("\n"),
    });

    const result = await routeLlmCall({
      // CHAT_GENERATE = grok-4 (non-reasoning generator). Mass captions hit
      // the same chain-of-thought verbosity issue with grok-4.1-reasoning
      // that we fixed by switching to grok-4 — same fix applies here. The
      // chat generator handles short flirty prose reliably.
      task: "CHAT_GENERATE",
      messages,
      maxTokens: 300,
      temperature: 0.95,
      responseFormat: "json_object",
      meta: {
        conversationId: args.conversationId,
        subscriberId: args.subscriberId,
        accountId: args.accountId,
        nudgeKind: args.kind,
        nudgeStep: args.step,
      },
    });

    const text = extractNudgeText(result.content);
    if (!text || text.length < 3 || text.length > 280 || isPlaceholderText(text)) {
      logger.warn(
        {
          conversationId: args.conversationId,
          contentLength: result.content.length,
          extractedLength: text.length,
          extracted: text.slice(0, 100),
          rawPreview: result.content.slice(0, 200),
        },
        "nudge LLM output rejected (empty / too long / placeholder)",
      );
      return null;
    }
    // Record successful nudge text so future nudges to same fan don't echo it.
    await recordRecentNudgeText(args.accountId, args.conversationId, text);
    return text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, conversationId: args.conversationId },
      "nudge LLM generation failed — falling back to template",
    );
    return null;
  }
}

/**
 * Pull the nudge text out of the LLM response. Primary path is JSON mode
 * ({"nudge": "..."}). Fallbacks cover models that ignore the format.
 */
function extractNudgeText(raw: string): string {
  const trimmed = raw.trim();
  // 1. Pure JSON
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.nudge === "string") return cleanNudge(obj.nudge);
      if (typeof obj.text === "string") return cleanNudge(obj.text);
      if (typeof obj.caption === "string") return cleanNudge(obj.caption);
    }
  } catch {
    /* fall through */
  }
  // 2. Embedded JSON
  const jsonMatch = trimmed.match(/\{[\s\S]*?"(?:nudge|text|caption)"\s*:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const unescaped = JSON.parse(`"${jsonMatch[1]!}"`) as string;
      if (unescaped.length >= 3) return cleanNudge(unescaped);
    } catch {
      /* fall through */
    }
  }
  // 3. Last non-empty line of plausible length
  const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 0) {
    const last = lines[lines.length - 1]!;
    if (last.length >= 5 && last.length <= 280) return cleanNudge(last);
  }
  // 4. Whole body trimmed
  return cleanNudge(trimmed);
}

function cleanNudge(s: string): string {
  return s.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
}

/** Reject obvious placeholder strings the model occasionally echoes. */
function isPlaceholderText(s: string): boolean {
  if (!s) return false;
  const t = s.trim();
  if (/^<.*>$/.test(t) || /^\[.*\]$/.test(t)) return true;
  if (t.startsWith("<") || t.startsWith("[")) return true;
  if (/your\s+(actual\s+)?(flirty\s+)?(nudge|caption|message)/i.test(t)) return true;
  if (t.length < 12) {
    return /^(text|nudge|caption|placeholder|example|fill in|the nudge)\s*(here)?$/i.test(t);
  }
  return false;
}

async function sendNudge(args: SendNudgeArgs): Promise<void> {
  const recentEntry: RecentNudge = {
    at: new Date().toISOString(),
    conversationId: args.conversationId,
    fanExternalId: args.fanExternalId,
    kind: args.kind,
    step: args.step,
    text: args.text,
    dryRun: env.NUDGE_DRY_RUN,
  };
  RECENT_NUDGES.unshift(recentEntry);
  if (RECENT_NUDGES.length > RECENT_NUDGES_MAX) RECENT_NUDGES.length = RECENT_NUDGES_MAX;

  if (env.NUDGE_DRY_RUN) {
    logger.info(recentEntry, "nudge dry-run (no send)");
    return;
  }

  // Insert the outbound row first so we have a message_id to attach to the
  // outbound queue job. Use kind="text" since MessageKind doesn't have a
  // "nudge" variant; the recent-nudges diag endpoint surfaces these
  // separately for inspection.
  const { id: messageId } = await insertOutboundDraft({
    conversationId: args.conversationId,
    text: args.text,
    kind: "text",
  });

  await outboundQueue().add(
    "nudge",
    {
      conversationId: args.conversationId,
      messageId,
      accountId: args.accountId,
      subscriberId: args.subscriberId,
      subscriberExternalId: args.fanExternalId,
      kind: "text",
      text: args.text,
      bubbleIndex: 0,
      bubbleCount: 1,
    },
    { jobId: `nudge-${messageId}` },
  );
  logger.info(recentEntry, "nudge enqueued");
}
