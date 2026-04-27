import { sql, type SqlBool } from "kysely";
import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import { db } from "../db/client.js";
import { outboundQueue } from "../queue/outbound.js";
import { insertOutboundDraft } from "../db/repos/messages.js";

/**
 * Auto-nudge worker.
 *
 * Two passes, both running in the same tick (every NUDGE_TICK_MS):
 *
 *   1. IDLE FAN re-engagement
 *      - Fan stopped replying after a normal exchange
 *      - Ladder: 30 min → 5 h → 10 h, capped at 3 nudges
 *      - Counter resets when fan sends an inbound message (handled by the
 *        conversation worker, which clears state_ctx.nudge on each inbound)
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

// Idle fan re-engagement ladder (ms since fan's last inbound).
const IDLE_LADDER_MS = [
  30 * 60_000, // 1st nudge after 30 min
  5 * 60 * 60_000, // 2nd nudge after 5 h
  10 * 60 * 60_000, // 3rd nudge after 10 h
];

const IDLE_TEMPLATES: string[][] = [
  // First nudge — soft check-in
  ["hey u still around babe?", "u disappear on me lol", "where u been hiding"],
  // Second nudge — slightly more deliberate, 5h later
  ["yo stranger, u alive?", "miss u babe, hope ur day went ok", "u been mia, hit me up when u can"],
  // Third + final — give up gracefully, leave door open
  ["hope ur having a good week, lmk when u got a sec", "still thinkin bout u, come back soon babe"],
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
const DISENGAGE_PATTERNS = [
  /\bstop\b/i,
  /\bleave me alone\b/i,
  /\bunsub/i,
  /\bbug(?:ging)? off\b/i,
  /\bblock(?:ed|ing)?\b/i,
  /\bgoodbye\b/i,
  /\bbye for good\b/i,
  /\bnot interested\b/i,
];

interface NudgeState {
  idleCount?: number;
  lastIdleAt?: string;
  ppvNudges?: Record<string, number>;
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

      // Skip if the most recent inbound text contains disengagement signals.
      if (await fanIsDisengaging(row.conv_id)) continue;

      // Pick a template for this step + a random variant for variety.
      const step = idleCount;
      const variants = IDLE_TEMPLATES[step]!;
      const text = variants[Math.floor(Math.random() * variants.length)]!;

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

      // Skip if disengaged
      if (await fanIsDisengaging(row.conv_id)) continue;

      const variants = PPV_TEMPLATES[attemptCount]!;
      const text = variants[Math.floor(Math.random() * variants.length)]!;

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
