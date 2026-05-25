import { sql, type SqlBool } from "kysely";
import { logger } from "../observability/logger.js";
import { env } from "../config/index.js";
import { db } from "../db/client.js";
import { outboundQueue } from "../queue/outbound.js";
import { sharedRedis } from "../queue/redis.js";
import { insertOutboundDraft, loadRecentMessages } from "../db/repos/messages.js";
import { ensureConversation } from "../db/repos/conversations.js";
import { loadIdentityLayer } from "../prompt/layers/identity.js";
import { HUMANNESS_LAYER, HUMANNESS_VERSION } from "../prompt/layers/humanness.js";
import { CONTRACT_LAYER, CONTRACT_VERSION } from "../prompt/layers/contract.js";
import { routeLlmCall } from "../llm/router.js";
import type { LlmMessage } from "../llm/types.js";
import { isFanUnreachable } from "../platform/impl/http/unreachable.js";
import { isConversationDisengaged } from "./disengagement.js";
import { isConversationBotFlagged } from "./botDetection.js";

/**
 * Outreach worker — proactive DMs to subs the chat-reply pipeline can't reach.
 *
 * Two passes:
 *
 *   1. COLD OUTREACH — subs who have NEVER sent an inbound. Fan subscribed
 *      but lurks; without a proactive DM we never engage them at all. The
 *      n8n welcome DM is meant to catch them at sub-time, but a meaningful
 *      fraction don't reply to that either. We fire up to 3 cold attempts
 *      spaced ~7 days apart. After 3 with no reply, mark cold-exhausted.
 *      Operator's #1 problem 2026-04-30: 2K subs, ~20 chatting in any 8h
 *      window — the other ~1980 are lurkers this targets.
 *
 *   2. REACTIVATION — fans who DID chat once but went silent 14+ days ago.
 *      Different from idle nudge (which fires at 30m/2h/6h). Reactivation
 *      is the long-tail — sub still has the account, hasn't touched DMs in
 *      weeks. Fire one warm "miss u" message; if no reply, fire one more
 *      at 30 days; then stop forever.
 *
 * Both paths share the same Redis lock infrastructure as the nudge worker
 * (peach:outreach:lock:<convId> with 24h TTL — these fire FAR less often
 * than nudges so the lock window is correspondingly longer).
 *
 * SAFETY:
 *   - OUTREACH_ENABLED env defaults false (master kill).
 *   - OUTREACH_DRY_RUN logs would-send without enqueueing outbound.
 *   - Same per-conversation Redis lock as nudges; per-account token bucket
 *     gates send rate too.
 *   - Disengagement keyword scan on prior inbound (if any); skipped when
 *     fan said "stop" / "leave me alone" / etc.
 *   - Cold outreach: cap 3 attempts ever, then the Redis exhausted-flag
 *     blocks until a fan-initiated reply resets it (handled in
 *     conversationWorker.handleMessageReceived).
 *   - Reactivation: cap 2 attempts, then exhausted forever.
 *
 * STATE STORAGE: same conversations.state_ctx.outreach jsonb pattern
 *     {
 *       outreach: {
 *         coldCount: 0|1|2|3,
 *         lastColdAt: "<iso>",
 *         reactCount: 0|1|2,
 *         lastReactAt: "<iso>"
 *       }
 *     }
 */

const TICK_MS = 30 * 60_000;             // 30 min — outreach is much rarer than nudges
const STARTUP_DELAY_MS = 60_000;         // 1 min cold-start so DB connections settle

const COLD_FIRST_DELAY_MS = 24 * 3600_000;       // first cold attempt only after 24h sub age
const COLD_INTERVAL_MS = 5 * 24 * 3600_000;      // 5 days between cold attempts
const COLD_MAX_ATTEMPTS = 3;

const REACT_FIRST_DELAY_MS = 14 * 24 * 3600_000; // first reactivation after 14 days silent
const REACT_INTERVAL_MS = 16 * 24 * 3600_000;    // ~30 day total at attempt 2
const REACT_MAX_ATTEMPTS = 2;

const LOCK_TTL_SEC = 24 * 3600;          // 24h lock per conv (outreach is far rarer than nudges)
const RECENT_TTL_SEC = 30 * 24 * 3600;   // 30 day text-dedup retention

/**
 * Active-hours window for reactivation outreach. We don't know the fan's
 * timezone, but we know the hour-of-day they last messaged us — that's a
 * usable proxy for "their active window." Send within ±5h of their typical
 * hour. Skip outside that — saves the contact attempt for a moment when
 * they're more likely to see and reply, instead of pinging at 4am their time
 * and burning a one-shot reactivation card.
 *
 * Cold pass has no per-fan timing data, so it skips this filter (sends
 * whenever the tick fires; tick rate already throttles to 30min).
 */
const ACTIVE_HOURS_WINDOW = 5;
function isWithinActiveHours(referenceUtc: Date, nowUtc: Date, windowHours: number): boolean {
  const refHour = referenceUtc.getUTCHours();
  const nowHour = nowUtc.getUTCHours();
  const diff = Math.min(
    Math.abs(nowHour - refHour),
    24 - Math.abs(nowHour - refHour), // wrap around midnight
  );
  return diff <= windowHours;
}

// Disengagement keywords — never outreach a fan whose recent inbound
// indicates they want to be left alone. Same scope as nudgeWorker's
// patterns (which see the operator audit comment for the 3-bucket
// rationale) — kept duplicated to avoid module coupling.
const DISENGAGE_PATTERNS = [
  // Explicit refusal
  /\bstop\b/i,
  /\bleave me alone\b/i,
  /\bunsub/i,
  /\bblock(?:ed|ing)?\b/i,
  /\bgoodbye\b/i,
  /\bnot interested\b/i,
  /\bdo not (?:contact|message|dm)\b/i,
  // Economic disengagement
  /\b(?:out of|no|low on|short on) (?:money|cash|funds)\b/i,
  /\b(?:cant?|can'?t|cannot)\s+afford\b/i,
  /\b(?:im|i am|i'?m)\s+broke\b/i,
  /\b(?:money|funds?|cash)\s+(?:so|too|are|is)?\s*low\b/i,
  /\bnext (?:paycheck|payday|paydate|check)\b/i,
  /\bsave\s+up\b/i,
  /\bbroke\s+(?:rn|right now|atm|af)\b/i,
  // Polite blow-offs
  /\b(?:maybe|talk)\s+later\b/i,
  /\bi(?:'?ll|ll)\s+(?:think|let u know|get back|see)\b/i,
  /\b(?:ill|i will)\s+see\b/i,
  /\bgotta (?:go|run|head)\b/i,
  /\b(?:gtg|brb)\b/i,
  /\bbusy (?:rn|right now|atm)\b/i,
];

// Static fallback templates if LLM call fails. Cold templates are
// curiosity-first because we know nothing about the fan; reactivation
// templates are nostalgic because there's history to lean on.
const COLD_TEMPLATES: string[][] = [
  [
    "hey babe, lurkin or just shy 👀 lemme know whats ur vibe",
    "hi there, been waitin for u to drop in my dms 🥺 whats ur scene",
    "saw u joined a min ago babe, what brought u my way",
  ],
  [
    "babe ur quiet rn 🥺 what kinda content u into",
    "still here lurkin? lmk what u like, ill make it worth ur time",
    "hi shy guy, drop me a hello so i know what u want",
  ],
  [
    "last time im checkin in babe, lmk if u wanna chat",
    "hope ur good, dms open whenever u feel like it 💕",
  ],
];

const REACT_TEMPLATES: string[][] = [
  [
    "hey stranger, been a min — what u been up to babe 🖤",
    "miss u tbh, hows life treatin u",
    "u dropped off on me babe, where u been",
  ],
  [
    "hey babe, hopin everythings good — lmk if u wanna catch up",
    "last attempt to lure u back hun, dms open if u wanna play 💕",
  ],
];

// ─── Recent text dedup rings ─────────────────────────────────────────────
// Per-fan ring: catches repeated openers in the same conversation across
// nudge ladder steps.
// Account-wide cold ring: catches the "every cold outreach across DIFFERENT
// fans uses the same opener" pattern (operator-observed 2026-05-08: 18
// fresh cold sends all followed "hey [name], i see u lurkin 👀" template).
// The per-fan ring couldn't catch this because each cold conversation is
// brand new with an empty per-fan history.

const recentTextKey = (accountId: string, conversationId: string): string =>
  `peach:outreach:recent:${accountId}:${conversationId}`;
const recentAccountColdKey = (accountId: string): string =>
  `peach:outreach:recent_cold_account:${accountId}`;
const RECENT_TEXTS_MAX = 8;
const RECENT_ACCOUNT_COLD_MAX = 20;

async function loadRecentOutreachTexts(accountId: string, conversationId: string): Promise<string[]> {
  try {
    return await sharedRedis().lrange(recentTextKey(accountId, conversationId), 0, RECENT_TEXTS_MAX - 1);
  } catch {
    return [];
  }
}

async function loadRecentAccountColdTexts(accountId: string): Promise<string[]> {
  try {
    return await sharedRedis().lrange(recentAccountColdKey(accountId), 0, RECENT_ACCOUNT_COLD_MAX - 1);
  } catch {
    return [];
  }
}

// Loose normalization for near-duplicate detection. Lowercase, strip emoji,
// strip leading "hey " + first capitalized word (the fan's name), strip
// punctuation, collapse whitespace. Two texts whose normalized form matches
// are treated as duplicates by the hard-reject gate below.
//
// Why strip the name: post-deploy monitoring 2026-05-22 found cold sends
// like "Mike u got my attention already dms open whenever" and
// "Hooblajax1, u got my attention already dms open whenever" — same
// trailing phrase across 11 fans in one batch. Exact normalized match
// failed because the leading name made each string unique. Stripping
// the leading name forces dedup on the STRUCTURAL phrase.
function normalizeForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    // Strip leading "hey " greeting
    .replace(/^hey\s+/i, "")
    // Strip the first word (typically the fan's name) plus optional trailing comma
    .replace(/^[a-z0-9_]+,?\s*/, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function recordRecentOutreachText(
  accountId: string,
  conversationId: string,
  text: string,
  kind: "cold" | "react",
): Promise<void> {
  try {
    const r = sharedRedis();
    const k = recentTextKey(accountId, conversationId);
    await r.lpush(k, text);
    await r.ltrim(k, 0, RECENT_TEXTS_MAX - 1);
    await r.expire(k, RECENT_TTL_SEC);
    if (kind === "cold") {
      const ak = recentAccountColdKey(accountId);
      await r.lpush(ak, text);
      await r.ltrim(ak, 0, RECENT_ACCOUNT_COLD_MAX - 1);
      await r.expire(ak, RECENT_TTL_SEC);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, accountId, conversationId },
      "failed to record outreach text",
    );
  }
}

// ─── Conv-wide outreach lock ─────────────────────────────────────────────

const lockKey = (convId: string): string => `peach:outreach:lock:${convId}`;

async function tryAcquireLock(convId: string): Promise<boolean> {
  try {
    const r = await sharedRedis().set(lockKey(convId), "1", "EX", LOCK_TTL_SEC, "NX");
    return r === "OK";
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, convId },
      "outreach lock acquire failed — failing closed",
    );
    return false;
  }
}

// ─── State_ctx helpers ───────────────────────────────────────────────────

interface OutreachState {
  coldCount?: number;
  lastColdAt?: string;
  reactCount?: number;
  lastReactAt?: string;
}

function readOutreachState(stateCtx: unknown): OutreachState {
  if (!stateCtx || typeof stateCtx !== "object") return {};
  const obj = stateCtx as Record<string, unknown>;
  const o = obj.outreach;
  if (!o || typeof o !== "object") return {};
  return o as OutreachState;
}

async function writeOutreachState(convId: string, next: OutreachState): Promise<void> {
  await sql`
    UPDATE v3.conversations
    SET state_ctx = jsonb_set(coalesce(state_ctx, '{}'::jsonb), '{outreach}', ${JSON.stringify(next)}::jsonb, true)
    WHERE id = ${convId}
  `.execute(db);
}

/**
 * Reset outreach counters when a fan finally replies. Called from
 * conversationWorker on every inbound webhook so a fan who ghosted but came
 * back gets a fresh outreach ladder if they go silent again.
 * Also drops the conv-wide outreach Redis lock for the same reason.
 */
export async function clearOutreachState(convId: string): Promise<void> {
  await Promise.all([
    sql`
      UPDATE v3.conversations
      SET state_ctx = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              coalesce(state_ctx, '{}'::jsonb),
              '{outreach,coldCount}', '0'::jsonb, true
            ),
            '{outreach,lastColdAt}', 'null'::jsonb, true
          ),
          '{outreach,reactCount}', '0'::jsonb, true
        ),
        '{outreach,lastReactAt}', 'null'::jsonb, true
      )
      WHERE id = ${convId}
    `.execute(db),
    sharedRedis().del(lockKey(convId)).catch(() => undefined),
  ]);
}

// ─── Recent-fires diag ring ──────────────────────────────────────────────

interface RecentOutreach {
  at: string;
  conversationId: string;
  fanExternalId: string;
  kind: "cold" | "react";
  step: number;
  text: string;
  dryRun: boolean;
}
const RECENT_OUTREACH: RecentOutreach[] = [];
const RECENT_OUTREACH_MAX = 50;
export function getRecentOutreach(): RecentOutreach[] {
  return RECENT_OUTREACH.slice();
}

// ─── LLM generator ────────────────────────────────────────────────────────

async function generateOutreachText(args: {
  conversationId: string;
  accountId: string;
  subscriberId: string;
  fanDisplayName: string | null;
  kind: "cold" | "react";
  step: number;
  /**
   * Additional recent sends from THIS tick — fed in by runColdPass so the
   * dedup gate sees same-batch prior generations. Without this, all N sends
   * in one tick race against the same Redis snapshot and get nearly identical
   * text (operator-observed 2026-05-22: 11 step-3 cold sends in 13s all had
   * "got my attention" / "dms open whenever").
   */
  extraRecentTexts?: string[];
}): Promise<string | null> {
  try {
    const history = args.kind === "react"
      ? await loadRecentMessages(args.conversationId, 8).catch(() => [])
      : [];
    const recentTexts = await loadRecentOutreachTexts(args.accountId, args.conversationId);
    // Account-wide cold dedup — for cold outreach, the per-fan ring is
    // always empty (brand-new conversation). Pull the last 20 cold sends
    // across ALL fans on this account so the LLM is told "you keep
    // shipping 'i see u lurkin 👀' on every cold send — vary it."
    // Pull the Redis ring AND merge with any same-tick sends from
    // extraRecentTexts so within-tick batches don't all race against the
    // pre-tick snapshot.
    const recentAccountCold = args.kind === "cold"
      ? [
          ...(args.extraRecentTexts ?? []),
          ...(await loadRecentAccountColdTexts(args.accountId)),
        ]
      : [];
    const identity = loadIdentityLayer(args.accountId);

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

    if (history.length > 0) {
      const transcript = history
        .filter((m) => (m.direction === "inbound" || m.direction === "outbound") && m.text)
        .slice(-8)
        .map((m) => `${m.direction === "inbound" ? "FAN" : "YOU"}: ${m.text}`)
        .join("\n");
      messages.push({
        role: "system",
        content: `# Past conversation (oldest → newest)\n${transcript}`,
      });
    }

    const objectiveByKind: Record<"cold" | "react", string[]> = {
      cold: [
        `STEP ${args.step + 1} of ${COLD_MAX_ATTEMPTS} — COLD OUTREACH. This fan has NEVER replied to you. They subscribed but lurk.`,
        `Goal: a curiosity-driven first-contact line that invites a reply without pressuring. NO past convo to hook to — work with the fact that they joined and haven't said anything yet.`,
        args.step === 0
          ? `STEP 1 vibe: light, playful, "i see u lurking 👀 / what got u in here". Curious, warm, not begging. ONE line, max 18 words.`
          : args.step === 1
            ? `STEP 2 vibe: a touch more deliberate. Acknowledge the silence, invite low-stakes reply. "still shy on me babe / lemme know what u like". ONE line, max 22 words.`
            : `STEP 3 (final) vibe: warm, no-pressure close. "last check-in babe, dms open whenever". Leave the door open without begging. ONE line, max 25 words.`,
      ],
      react: [
        `STEP ${args.step + 1} of ${REACT_MAX_ATTEMPTS} — REACTIVATION. This fan chatted with you before but went silent 14+ days ago. Pull from the past convo above.`,
        args.step === 0
          ? `STEP 1 vibe: warm "miss u" energy with one specific callback to something he said before if natural. "hey stranger, been a min — what u been up to". ONE line, max 22 words.`
          : `STEP 2 (final) vibe: last-attempt warmth, no begging, leaves the door open. "last time im sliding into ur dms hun, lmk if u ever wanna catch up". ONE line, max 25 words.`,
      ],
    };

    messages.push({
      role: "system",
      content: [
        ...objectiveByKind[args.kind],
        ``,
        `HARD RULES:`,
        `- ONE short message. No paragraphs.`,
        `- Match the active humanness layer voice. Specific to the moment.`,
        `- No pricing, no PPV pitch, no "unlock". This is rapport opening, not selling.`,
        `- No begging, no "please". Confident warmth.`,
        `- Cold outreach: do NOT reference any past message (there are none).`,
        ...(args.fanDisplayName
          ? [`- The fan's display name is "${args.fanDisplayName}". Optional: address them by name once for personal feel — but only if it's clearly a real first name (not a username with numbers).`]
          : []),
        ``,
        ...(recentTexts.length > 0
          ? [
              `RECENT outreach to this fan — DO NOT repeat these openers/themes:`,
              ...recentTexts.slice(0, 5).map((t, i) => `  ${i + 1}. ${t}`),
              ``,
            ]
          : []),
        ...(recentAccountCold.length > 0
          ? [
              `RECENT COLD OPENERS YOU'VE SENT TO OTHER FANS (last ~20) — DO NOT repeat the shape, opener, theme, key verb, or emoji placement of these:`,
              ...recentAccountCold.slice(0, 12).map((t, i) => `  ${i + 1}. ${t}`),
              ``,
              `THEME-LEVEL VARIETY (CRITICAL — operator-observed 2026-05-13: model locks on theme words like "chaos / ruin / wreck / lurkin" across many sends):`,
              `- If a key NOUN appears in 3+ of the recent sends above (e.g. "chaos", "web", "shadows"), STOP using that noun entirely for this send.`,
              `- If a key VERB appears in 3+ of the recent sends (e.g. "dragged", "pulled", "ruin", "wreck", "lurkin"), STOP using that verb entirely for this send.`,
              `- If the closing pattern is repeating ("...into my chaos daddy" / "...what brought u here babe"), break the pattern — change the SHAPE of the close.`,
              `- Rotate among these angles each send (pick one DIFFERENT from the recent batch):`,
              `  1. Direct hunger ("been waiting for someone like u")`,
              `  2. Possessive claim ("ur mine the second u showed up")`,
              `  3. Taunt ("think u can keep up with me?")`,
              `  4. Dark curiosity ("what made u brave enough to sub")`,
              `  5. Confident invitation ("tell me what u like, no hiding")`,
              `  6. Casual hi with edge ("hey, dont be shy on me")`,
              `  7. Observation ("u been quiet — that mean trouble?")`,
              `  8. Compliment-bait ("u got my attention, now what")`,
              `Each fan deserves a UNIQUE-feeling message. If the recent sends are all aggressive, try a softer one (vice versa). The persona character holds — just rotate the angle.`,
              ``,
            ]
          : []),
        `OUTPUT FORMAT — STRICT JSON. Return a single JSON object exactly like:`,
        `  {"text": "the actual message"}`,
        `Rules: no markdown fences, no prose around the JSON, no placeholder values like "text here" / "<...>" / "[...]".`,
      ].join("\n"),
    });

    const result = await routeLlmCall({
      task: "CHAT_GENERATE",
      messages,
      maxTokens: 250,
      temperature: 0.95,
      responseFormat: "json_object",
      meta: {
        conversationId: args.conversationId,
        subscriberId: args.subscriberId,
        accountId: args.accountId,
        kind: `outreach_${args.kind}`,
        step: args.step,
      },
    });

    const text = extractText(result.content);
    if (!text || text.length < 5 || text.length > 280 || isPlaceholderText(text)) {
      logger.warn(
        {
          conversationId: args.conversationId,
          rawLength: result.content.length,
          extractedLength: text.length,
          rawPreview: result.content.slice(0, 200),
        },
        "outreach LLM output rejected — falling back to template",
      );
      return null;
    }
    // Hard near-duplicate reject (cold pass only — react has per-fan history
    // so the per-conv ring suffices). Mirrors the nudge generator's fix:
    // even with "don't repeat" prompt context, grok-4 occasionally locks
    // onto a phrase across many fans ("u been quiet since subbin..." was
    // hit 15/35 cold step-2 sends in QA 2026-05-20). Null-out so caller
    // falls back to the static template pool which IS varied.
    if (args.kind === "cold") {
      const norm = normalizeForDedup(text);
      if (norm.length >= 6 && recentAccountCold.some((t) => normalizeForDedup(t) === norm)) {
        logger.warn(
          { conversationId: args.conversationId, text, accountId: args.accountId },
          "outreach cold LLM output rejected — near-duplicate of recent account send",
        );
        return null;
      }
    }
    await recordRecentOutreachText(args.accountId, args.conversationId, text, args.kind);
    return text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, conversationId: args.conversationId },
      "outreach LLM generation failed; using template",
    );
    return null;
  }
}

function extractText(raw: string): string {
  const t = raw.trim();
  try {
    const parsed = JSON.parse(t) as Record<string, unknown>;
    if (typeof parsed.text === "string") return clean(parsed.text);
    if (typeof parsed.message === "string") return clean(parsed.message);
    if (typeof parsed.nudge === "string") return clean(parsed.nudge);
  } catch {
    /* fall through */
  }
  const m = t.match(/\{[\s\S]*?"(?:text|message|nudge)"\s*:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?\}/);
  if (m) {
    try {
      const u = JSON.parse(`"${m[1]!}"`) as string;
      if (u.length >= 5) return clean(u);
    } catch {
      /* fall through */
    }
  }
  return clean(t);
}

function clean(s: string): string {
  return s.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
}

function isPlaceholderText(s: string): boolean {
  const t = s.trim();
  if (/^<.*>$/.test(t) || /^\[.*\]$/.test(t)) return true;
  if (t.startsWith("<") || t.startsWith("[")) return true;
  if (/your\s+(actual\s+)?(message|nudge|text|outreach)/i.test(t)) return true;
  if (t.length < 12) return /^(text|message|nudge|placeholder|example)\s*(here)?$/i.test(t);
  return false;
}

// ─── Worker passes ───────────────────────────────────────────────────────

interface FireArgs {
  conversationId: string;
  accountId: string;
  subscriberId: string;
  fanExternalId: string;
  fanDisplayName: string | null;
  kind: "cold" | "react";
  step: number;
  /** Sends generated earlier in this tick — used to dedup within a batch. */
  tickRecentTexts?: string[];
}

interface FireResult { fired: boolean; text: string | null }

async function fireOutreach(args: FireArgs): Promise<FireResult> {
  // Sticky disengagement flag (set by conversationWorker on explicit refusal).
  // Survives past the 3-inbound window of the keyword scan below.
  if (await isConversationDisengaged(args.conversationId)) {
    logger.info({ convId: args.conversationId }, "outreach skipped — sticky disengagement flag set");
    return { fired: false, text: null };
  }
  if (await isConversationBotFlagged(args.conversationId)) {
    logger.info({ convId: args.conversationId }, "outreach skipped — conversation flagged as bot");
    return { fired: false, text: null };
  }
  // Disengagement guard
  const recentInbounds = await db
    .selectFrom("v3.messages")
    .select("text")
    .where("conversation_id", "=", args.conversationId)
    .where("direction", "=", "inbound")
    .orderBy("created_at", "desc")
    .limit(3)
    .execute();
  for (const r of recentInbounds) {
    if (DISENGAGE_PATTERNS.some((p) => p.test(r.text ?? ""))) {
      logger.info({ convId: args.conversationId }, "outreach skipped — disengagement keyword in recent inbound");
      return { fired: false, text: null };
    }
  }

  if (!(await tryAcquireLock(args.conversationId))) {
    logger.debug({ convId: args.conversationId }, "outreach lock held — skipping");
    return { fired: false, text: null };
  }

  const llmText = await generateOutreachText({
    conversationId: args.conversationId,
    accountId: args.accountId,
    subscriberId: args.subscriberId,
    fanDisplayName: args.fanDisplayName,
    kind: args.kind,
    step: args.step,
    ...(args.tickRecentTexts ? { extraRecentTexts: args.tickRecentTexts } : {}),
  });
  const variants = (args.kind === "cold" ? COLD_TEMPLATES : REACT_TEMPLATES)[args.step]!;
  const text = llmText ?? variants[Math.floor(Math.random() * variants.length)]!;

  // Operator directive 2026-05-04: ignore env, always live. Cold outreach to
  // 423 never-chatted fans is the single biggest unused inventory and was
  // sitting in dry-run on Railway. Hardcoded false here so the env can't
  // accidentally re-pause it. Re-enable dry-run only by editing this file.
  const dryRunEffective = false;
  const entry: RecentOutreach = {
    at: new Date().toISOString(),
    conversationId: args.conversationId,
    fanExternalId: args.fanExternalId,
    kind: args.kind,
    step: args.step + 1,
    text,
    dryRun: dryRunEffective,
  };
  RECENT_OUTREACH.unshift(entry);
  if (RECENT_OUTREACH.length > RECENT_OUTREACH_MAX) RECENT_OUTREACH.length = RECENT_OUTREACH_MAX;

  if (dryRunEffective) {
    logger.info(entry, "outreach dry-run (no send)");
    return { fired: true, text };
  }

  const { id: messageId } = await insertOutboundDraft({
    conversationId: args.conversationId,
    text,
    kind: "text",
  });
  await outboundQueue().add(
    "outreach",
    {
      conversationId: args.conversationId,
      messageId,
      accountId: args.accountId,
      subscriberId: args.subscriberId,
      subscriberExternalId: args.fanExternalId,
      kind: "text",
      text,
      bubbleIndex: 0,
      bubbleCount: 1,
    },
    { jobId: `outreach-${messageId}` },
  );
  logger.info(entry, "outreach enqueued");
  return { fired: true, text };
}

/**
 * Manual trigger — runs one cold + reactivation pass right now and returns
 * the candidate / sent counts. Used by /admin/outreach-now to diagnose
 * silence (when /diag/recent-outreach is empty post-deploy). Safe to call
 * anytime; same locks/dedup as scheduled ticks.
 */
export async function triggerOutreachNow(): Promise<{
  cold: { candidates: number; sent: number };
  react: { candidates: number; sent: number };
}> {
  const cold = await runColdPass();
  const react = await runReactivationPass();
  return { cold, react };
}

async function runColdPass(): Promise<{ candidates: number; sent: number }> {
  // Subs with no inbound ever. Operator diagnosis 2026-05-07 (round 2):
  // the previous query INNER-JOINed v3.conversations, but subsync-imported
  // fans (the bulk of the 1,311 newly-imported subscribers) have no
  // conversation row yet — conversations are only created when a real
  // inbound message is processed. Bypassing INNER JOIN: now we query
  // subscribers directly, ensure the conversation row on-the-fly per
  // candidate via ensureConversation. Also dropped the 24h created_at
  // gate — subsync-imported fans have created_at = NOW (when the row
  // landed in our DB), but they may be MUCH older OF subscribers in
  // reality. The 24h gate was filtering everything subsync brought in.
  // Per-attempt cooldown still enforced in loop body via state.lastColdAt.

  const rows = await db
    .selectFrom("v3.subscribers as s")
    .innerJoin("v3.accounts as a", "a.id", "s.account_id")
    .select([
      "s.id as subscriber_id",
      "s.account_id as account_id",
      "s.external_id as fan_external_id",
      "s.display_name as display_name",
      "s.last_inbound_at as last_inbound_at",
      "s.last_outbound_at as last_outbound_at",
      "s.created_at as sub_created_at",
    ])
    .where("a.platform_account_id", "is not", null)
    .where("s.last_inbound_at", "is", null)               // never replied
    .where(sql<SqlBool>`s.external_id NOT LIKE 'loop-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'longtime-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE '%-probe-%'`)
    // Random sample of the never-chatted pool. Previously ordered DESC
    // LIMIT 100, same 100 newest subs came back every tick; after one
    // round all entered 5-day cooldown and the worker stalled — the
    // ~1,500 older never-chatted subs were never reached. Random sample
    // of 200 per tick + max-sends cap below keeps OFAPI load bounded
    // while rotating through the full pool over time.
    .orderBy(sql`random()`)
    .limit(200)
    .execute();

  let sent = 0;
  // Resolve platform account id for unreachable-fan lookup.
  const account = await db
    .selectFrom("v3.accounts")
    .select(["platform_account_id"])
    .where("id", "=", rows[0]?.account_id ?? "")
    .executeTakeFirst();
  const platformAccountId = (account?.platform_account_id ?? null) as string | null;

  // Per-tick send cap. With LIMIT 200 candidates + most eligible, we could
  // fire 200 cold sends in one tick which would hammer OFAPI's rate
  // limits (5K msgs/min cap shared with everything else). Capping at 40
  // per tick spreads sends across 30-min ticks at ~80/hour, which is
  // well within OFAPI's per-account rate envelope.
  const MAX_COLD_SENDS_PER_TICK = 40;
  let unreachableSkipped = 0;
  // Track texts sent THIS tick so each subsequent generation in the same
  // batch can dedup against same-tick sends (not just the Redis snapshot
  // from before the tick started). Fixes 2026-05-22 batch-repeat bug.
  const tickColdTexts: string[] = [];
  for (const row of rows) {
    if (sent >= MAX_COLD_SENDS_PER_TICK) break;
    try {
      // Skip fans OFAPI already told us are unreachable (blocked / unsubbed /
      // DM-disabled). Saves the LLM-generate + send round trip on dead fans.
      if (platformAccountId) {
        if (await isFanUnreachable(platformAccountId, row.fan_external_id)) {
          unreachableSkipped++;
          continue;
        }
      }
      // Ensure conversation row — may need creation for subsync-imported
      // fans that have never received a message webhook. Idempotent.
      const { id: convId } = await ensureConversation({
        subscriberId: row.subscriber_id,
        accountId: row.account_id,
      });
      // Re-read state_ctx after ensure (might be a fresh row).
      const convRow = await db
        .selectFrom("v3.conversations")
        .select("state_ctx")
        .where("id", "=", convId)
        .executeTakeFirst();
      const state = readOutreachState(convRow?.state_ctx ?? null);
      const coldCount = state.coldCount ?? 0;
      if (coldCount >= COLD_MAX_ATTEMPTS) continue;
      if (state.lastColdAt) {
        const sinceLast = Date.now() - new Date(state.lastColdAt).getTime();
        if (sinceLast < COLD_INTERVAL_MS) continue;
      }
      const result = await fireOutreach({
        conversationId: convId,
        accountId: row.account_id,
        subscriberId: row.subscriber_id,
        fanExternalId: row.fan_external_id,
        fanDisplayName: row.display_name,
        kind: "cold",
        step: coldCount,
        tickRecentTexts: tickColdTexts,
      });
      if (!result.fired) continue;
      if (result.text) tickColdTexts.unshift(result.text);
      await writeOutreachState(convId, {
        ...state,
        coldCount: coldCount + 1,
        lastColdAt: new Date().toISOString(),
      });
      sent++;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, subscriberId: row.subscriber_id },
        "cold outreach failed for one sub",
      );
    }
  }
  if (unreachableSkipped > 0) {
    logger.info({ unreachableSkipped }, "cold pass skipped unreachable fans");
  }
  return { candidates: rows.length, sent };
}

async function runReactivationPass(): Promise<{ candidates: number; sent: number }> {
  // Fans who chatted before but have been silent 14+ days.
  const reactCutoff = new Date(Date.now() - REACT_FIRST_DELAY_MS);

  const rows = await db
    .selectFrom("v3.conversations as c")
    .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
    .innerJoin("v3.accounts as a", "a.id", "c.account_id")
    .select([
      "c.id as conv_id",
      "c.account_id as account_id",
      "c.state_ctx as state_ctx",
      "s.id as subscriber_id",
      "s.external_id as fan_external_id",
      "s.display_name as display_name",
      "s.last_inbound_at as last_inbound_at",
    ])
    .where("a.platform_account_id", "is not", null)
    .where("s.last_inbound_at", "is not", null)
    .where(sql<SqlBool>`s.last_inbound_at < ${reactCutoff}`)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'loop-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE 'longtime-%'`)
    .where(sql<SqlBool>`s.external_id NOT LIKE '%-probe-%'`)
    .orderBy("s.last_inbound_at", "asc")
    .limit(50)
    .execute();

  let sent = 0;
  const now = new Date();
  for (const row of rows) {
    try {
      const state = readOutreachState(row.state_ctx);
      const reactCount = state.reactCount ?? 0;
      if (reactCount >= REACT_MAX_ATTEMPTS) continue;
      if (state.lastReactAt) {
        const sinceLast = Date.now() - new Date(state.lastReactAt).getTime();
        if (sinceLast < REACT_INTERVAL_MS) continue;
      }
      // Active-hours filter — only fire reactivation if current hour is
      // within ±5h of fan's last-inbound hour-of-day. Saves the one-shot
      // reactivation pitch for when fan is likely awake/active.
      if (row.last_inbound_at) {
        const lastHour = new Date(row.last_inbound_at as unknown as Date);
        if (!isWithinActiveHours(lastHour, now, ACTIVE_HOURS_WINDOW)) {
          continue;
        }
      }
      const result = await fireOutreach({
        conversationId: row.conv_id,
        accountId: row.account_id,
        subscriberId: row.subscriber_id,
        fanExternalId: row.fan_external_id,
        fanDisplayName: row.display_name,
        kind: "react",
        step: reactCount,
      });
      if (!result.fired) continue;
      await writeOutreachState(row.conv_id, {
        ...state,
        reactCount: reactCount + 1,
        lastReactAt: new Date().toISOString(),
      });
      sent++;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, convId: row.conv_id },
        "reactivation failed for one conv",
      );
    }
  }
  return { candidates: rows.length, sent };
}

// ─── Worker lifecycle ────────────────────────────────────────────────────

export interface OutreachWorkerHandle {
  stop: () => Promise<void>;
}

export function startOutreachWorker(): OutreachWorkerHandle | null {
  if (!env.OUTREACH_ENABLED) {
    logger.info("outreach worker disabled (OUTREACH_ENABLED=false)");
    return null;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const cold = await runColdPass();
      const react = await runReactivationPass();
      if (cold.candidates > 0 || react.candidates > 0) {
        logger.info(
          {
            coldCandidates: cold.candidates,
            coldSent: cold.sent,
            reactCandidates: react.candidates,
            reactSent: react.sent,
          },
          "outreach tick",
        );
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "outreach tick failed",
      );
    } finally {
      if (!stopped) timer = setTimeout(tick, TICK_MS);
    }
  };

  timer = setTimeout(tick, STARTUP_DELAY_MS);
  logger.info({ tickMs: TICK_MS, dryRun: env.OUTREACH_DRY_RUN }, "outreach worker started");

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
