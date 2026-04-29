import http from "node:http";
import { randomUUID } from "node:crypto";
import { sql, type SqlBool } from "kysely";
import { logger } from "../observability/logger.js";
import { renderMetrics } from "../observability/metrics.js";
import { disableTakeover, enableTakeover, isTakenOver } from "../admin/takeover.js";
import { inboundQueue, serializeEvent } from "../queue/inbound.js";
import { env } from "../config/index.js";
import { db } from "../db/client.js";
import { getPlatformAdapter } from "../platform/index.js";
import {
  loadAccountByPlatformId,
  loadAccountById,
  loadAccountByCreatorUuid,
  upsertShadowAccount,
} from "../db/repos/accounts.js";
import { generateMassCaption, isValidVibe } from "../mass/caption.js";
import { getRecentPlatformErrors, parseRetryAfter, getLastRateLimitInfo } from "../platform/impl/http/client.js";
import {
  recordWebhookEvent,
  getRecentWebhookEvents,
  getRecentSkipReasons,
} from "../observability/diag_rings.js";
import { turnQueue } from "../queue/turns.js";
import { outboundQueue } from "../queue/outbound.js";
import { getRecentNudges } from "../worker/nudgeWorker.js";
import { getRecentOutreach } from "../worker/outreachWorker.js";
import { getRecentPitchDecisions, turnsSinceLastPitch as ppvTurnsSinceLastPitch } from "../ppv/orchestrator.js";
import { listRecentAttempts, countUnboughtRecentPitches } from "../db/repos/ppv_attempts.js";
import { listPurchasesByFan, parseLegacySourceRef } from "../db/repos/purchases.js";
import { pickNextForFan } from "../ppv/scriptPicker.js";
import { getFunnelStep } from "../ppv/funnel.js";
import { loadLatestArchetype } from "../db/repos/archetypes.js";

export interface AdminServerHandle {
  stop(): Promise<void>;
}

/**
 * Minimal HTTP surface for the admin UI + ops probes. Dependency-free so we
 * don't pull in Fastify/Express before we need route parsing. Routes:
 *
 *   GET  /health                                    liveness
 *   GET  /metrics                                   Prometheus scrape
 *   GET  /admin/threads                             list of conversations + last message
 *   GET  /admin/threads/:id                         one conversation with all messages + archetype
 *   GET  /admin/conversations/:id/why               assembled prompt + output for last turn
 *   POST /admin/conversations/:id/takeover/on|off   toggle operator takeover
 *   POST /admin/halt-fan?name=X|external_id=Y[&action=on|off]
 *                                                  one-shot find-and-takeover by name / external id
 *   GET  /admin/conversations/:id/pitch-state       phase, drip cadence, next-pick, funnel, purchase history
 *   POST /admin/mass-caption?account=X[&vibe=Y]     grok-4.1 mass-message caption (replaces static n8n pool)
 *   POST /admin/bulk-unsend?sinceMinutes=N[...&dryRun=false]
 *                                                  bulk-unsend recent outbound (panic button)
 *   POST /admin/test/inject                         inject a fake inbound message (testing)
 *
 * Auth: ADMIN_TOKEN env required on /admin paths; if unset, /admin returns 503
 * so a misconfigured deploy can't accidentally expose the surface.
 */
export function startAdminServer(): AdminServerHandle {
  // Railway / Render / Fly inject a PORT env var the backend MUST bind to.
  // Fall back to ADMIN_PORT (8787) for local dev.
  const port = process.env.PORT ? Number(process.env.PORT) : env.ADMIN_PORT;
  const token = env.ADMIN_TOKEN ?? null;

  const server = http.createServer((req, res) => {
    // CORS: dev-mode convenience so the frontend (vite :5173) can call the
    // admin API directly. Adjust the origin whitelist if you lock this down.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization,content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    handle(req, res, token).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, stack: err instanceof Error ? err.stack : undefined }, "admin handler crashed");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    });
  });

  server.listen(port, () => logger.info({ port }, "admin server listening"));

  return {
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string | null,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    return json(res, 200, { ok: true });
  }

  // Diagnostic endpoint — returns what env values the live process is reading.
  // Use this to settle "did my Railway env-var change actually take effect?"
  // questions without hunting through deploy logs. No auth required so we can
  // hit it from anywhere; only exposes booleans + lengths, never raw secrets.
  // Recent platform HTTP errors (in-memory ring buffer). Lets us debug send
  // failures without finding Railway deploy logs. No auth required.
  if (method === "GET" && path === "/diag/recent-errors") {
    return json(res, 200, { errors: getRecentPlatformErrors() });
  }

  // Recent nudges (idle re-engagement + PPV no-buy follow-ups). Process-local
  // ring buffer; clears on restart.
  if (method === "GET" && path === "/diag/recent-nudges") {
    return json(res, 200, { nudges: getRecentNudges() });
  }

  // Recent outreach fires (cold + reactivation). Same shape as nudges; gives
  // the operator visibility into proactive DMs to silent subs / lapsed fans.
  if (method === "GET" && path === "/diag/recent-outreach") {
    return json(res, 200, { outreach: getRecentOutreach() });
  }

  // Engagement dashboard — aggregate funnel metrics for the last N hours.
  // GET /diag/engagement?hours=8 (default 8, max 168=7d).
  // Lets the operator see "subs total / chatted ever / chatted recent /
  // unlocked / revenue / phase distribution / top spenders" without running
  // SQL. The numbers that drive every "what should we ship next" question.
  if (method === "GET" && path === "/diag/engagement") {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") ?? 8)));
      const cutoff = new Date(Date.now() - hours * 3600_000);
      const reactCutoff = new Date(Date.now() - 14 * 24 * 3600_000);

      // Three queries in parallel — kept simple; can be optimized later.
      const [funnel, phases, topFans, lurkers] = await Promise.all([
        // Funnel snapshot
        db
          .selectFrom("v3.subscribers")
          .select([
            sql<string>`count(*)`.as("total_subs"),
            sql<string>`count(*) filter (where last_inbound_at is not null)`.as("ever_chatted"),
            sql<string>`count(*) filter (where last_inbound_at >= ${cutoff})`.as("chatted_in_window"),
            sql<string>`count(*) filter (where last_inbound_at is null)`.as("never_chatted"),
            sql<string>`count(*) filter (where last_inbound_at < ${reactCutoff} and last_inbound_at is not null)`.as("lapsed_14d_plus"),
            sql<string>`coalesce(sum(total_spend_cents), 0)`.as("lifetime_revenue_cents"),
            sql<string>`coalesce(sum(spend_30d_cents), 0)`.as("revenue_30d_cents"),
          ])
          .executeTakeFirst(),
        // Phase distribution
        db
          .selectFrom("v3.conversations")
          .select(["phase", sql<string>`count(*)`.as("count")])
          .groupBy("phase")
          .execute(),
        // Top fans by total spend (lifetime, all-time). Synthetic test fans
        // from the V3 testing harness are excluded to keep the operator's
        // top-fans list reflective of REAL revenue.
        db
          .selectFrom("v3.subscribers")
          .select(["external_id", "display_name", "total_spend_cents", "spend_30d_cents", "last_inbound_at"])
          .where(sql<SqlBool>`total_spend_cents > 0`)
          .where(sql<SqlBool>`external_id NOT LIKE 'loop-%'`)
          .where(sql<SqlBool>`external_id NOT LIKE 'longtime-%'`)
          .where(sql<SqlBool>`external_id NOT LIKE '%-probe-%'`)
          .orderBy("total_spend_cents", "desc")
          .limit(10)
          .execute(),
        // Cold-outreach candidates count (gives a sense of unreached pool)
        db
          .selectFrom("v3.subscribers")
          .select([sql<string>`count(*)`.as("count")])
          .where("last_inbound_at", "is", null)
          .where(sql<SqlBool>`created_at < ${new Date(Date.now() - 24 * 3600_000)}`)
          .where(sql<SqlBool>`external_id NOT LIKE 'loop-%'`)
          .executeTakeFirst(),
      ]);

      // Window-scoped pitch + message counts
      const [windowMessages, windowPitches] = await Promise.all([
        db
          .selectFrom("v3.messages")
          .select([
            sql<string>`count(*) filter (where direction='inbound')`.as("inbound"),
            sql<string>`count(*) filter (where direction='outbound')`.as("outbound"),
            sql<string>`count(*) filter (where direction='outbound' and sent_at is null)`.as("outbound_unsent"),
          ])
          .where(sql<SqlBool>`created_at >= ${cutoff}`)
          .executeTakeFirst(),
        db
          .selectFrom("v3.ppv_attempts")
          .select([
            sql<string>`count(*)`.as("total"),
            sql<string>`count(*) filter (where outcome='unlocked')`.as("unlocked"),
            sql<string>`count(*) filter (where outcome='pending')`.as("pending"),
            sql<string>`count(*) filter (where outcome='expired')`.as("expired"),
            sql<string>`coalesce(sum(price_cents) filter (where outcome='unlocked'), 0)`.as("revenue_window_cents"),
          ])
          .where(sql<SqlBool>`pitched_at >= ${cutoff}`)
          .executeTakeFirst(),
      ]);

      return json(res, 200, {
        windowHours: hours,
        funnel: {
          totalSubs: Number(funnel?.total_subs ?? 0),
          everChatted: Number(funnel?.ever_chatted ?? 0),
          chattedInWindow: Number(funnel?.chatted_in_window ?? 0),
          neverChatted: Number(funnel?.never_chatted ?? 0),
          lapsed14dPlus: Number(funnel?.lapsed_14d_plus ?? 0),
          lifetimeRevenueCents: Number(funnel?.lifetime_revenue_cents ?? 0),
          revenue30dCents: Number(funnel?.revenue_30d_cents ?? 0),
        },
        windowMessages: {
          inbound: Number(windowMessages?.inbound ?? 0),
          outbound: Number(windowMessages?.outbound ?? 0),
          outboundUnsent: Number(windowMessages?.outbound_unsent ?? 0),
        },
        windowPitches: {
          total: Number(windowPitches?.total ?? 0),
          unlocked: Number(windowPitches?.unlocked ?? 0),
          pending: Number(windowPitches?.pending ?? 0),
          expired: Number(windowPitches?.expired ?? 0),
          revenueCents: Number(windowPitches?.revenue_window_cents ?? 0),
          conversionRate: windowPitches && Number(windowPitches.total) > 0
            ? Number(((Number(windowPitches.unlocked) / Number(windowPitches.total)) * 100).toFixed(1))
            : 0,
        },
        phaseDistribution: phases.map((p) => ({
          phase: p.phase,
          count: Number(p.count),
        })),
        topFans: topFans.map((f) => ({
          externalId: f.external_id,
          displayName: f.display_name,
          totalSpendCents: Number(f.total_spend_cents ?? 0),
          spend30dCents: Number(f.spend_30d_cents ?? 0),
          lastInboundAt: f.last_inbound_at,
        })),
        coldOutreachCandidates: Number(lurkers?.count ?? 0),
      });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Recent pitch decisions: WHY the picker decided to pitch (or not).
  // Critical for debugging "bot didn't pitch when fan asked how much" cases.
  if (method === "GET" && path === "/diag/recent-pitches") {
    return json(res, 200, { decisions: getRecentPitchDecisions() });
  }

  if (method === "GET" && path === "/diag/rate-limit") {
    return json(res, 200, { lastSeen: getLastRateLimitInfo() });
  }

  // BullMQ queue depths — surfaces inbound / turn / outbound counts so we can
  // see if events are stacking up unprocessed. Public read; no sensitive data.
  if (method === "GET" && path === "/diag/queue-depth") {
    try {
      const [inb, trn, out] = await Promise.all([
        inboundQueue().getJobCounts("waiting", "active", "delayed", "failed"),
        turnQueue().getJobCounts("waiting", "active", "delayed", "failed"),
        outboundQueue().getJobCounts("waiting", "active", "delayed", "failed"),
      ]);
      return json(res, 200, { inbound: inb, turn: trn, outbound: out });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Last 100 webhook receives — kind, source IP trust, parsed/enqueued counts.
  // Lets the operator confirm OFAPI is delivering events to V3 at all.
  if (method === "GET" && path === "/diag/webhook-events") {
    return json(res, 200, { events: getRecentWebhookEvents() });
  }

  // Last 100 turn-worker skip reasons. Captures the SILENT skip paths
  // (lock contention, generator parse fail, humanizer empty, hard timeout)
  // that don't show up anywhere else. Critical for "why didn't bot reply".
  if (method === "GET" && path === "/diag/skip-reasons") {
    return json(res, 200, { skips: getRecentSkipReasons() });
  }

  // Sample of FAILED jobs from each queue with their last error message.
  // Lets the operator see WHY jobs are failing without raw Redis access.
  // Public diag (no sensitive data, just job metadata + failure reason).
  if (method === "GET" && path === "/diag/failed-jobs") {
    try {
      const [turnFailed, outFailed, inbFailed] = await Promise.all([
        turnQueue().getFailed(0, 9),
        outboundQueue().getFailed(0, 9),
        inboundQueue().getFailed(0, 9),
      ]);
      const fmt = (jobs: Array<{ id?: string; data?: unknown; failedReason?: string; attemptsMade?: number; timestamp?: number }>) =>
        jobs.map((j) => ({
          id: j.id,
          attemptsMade: j.attemptsMade,
          failedReason: j.failedReason,
          enqueuedAt: j.timestamp ? new Date(j.timestamp).toISOString() : null,
          // Truncate data to keep response small.
          dataPreview: typeof j.data === "object" && j.data !== null
            ? Object.keys(j.data as Record<string, unknown>).reduce((acc, k) => {
                const v = (j.data as Record<string, unknown>)[k];
                acc[k] = typeof v === "string" && v.length > 80 ? `${v.slice(0, 80)}...` : v;
                return acc;
              }, {} as Record<string, unknown>)
            : null,
        }));
      return json(res, 200, {
        turn: fmt(turnFailed),
        outbound: fmt(outFailed),
        inbound: fmt(inbFailed),
      });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (method === "GET" && path === "/diag/runtime-flags") {
    return json(res, 200, {
      shadow_mode: env.SHADOW_MODE,
      shadow_mode_type: typeof env.SHADOW_MODE,
      platform_mode: env.PLATFORM_MODE,
      polling_enabled: env.POLLING_ENABLED,
      account_allowlist_size: env.PLATFORM_ACCOUNT_ALLOWLIST?.split(",").filter(Boolean).length ?? 0,
      account_allowlist_first: env.PLATFORM_ACCOUNT_ALLOWLIST?.split(",")[0]?.trim() ?? null,
      api_key_length: env.PLATFORM_API_KEY?.length ?? 0,
      api_key_prefix: env.PLATFORM_API_KEY?.slice(0, 8) ?? null,
      always_awake_raw: process.env.PERSONA_ALWAYS_AWAKE ?? "(unset)",
      shadow_mode_raw: process.env.SHADOW_MODE ?? "(unset)",
      send_ramp_up_until: env.SEND_RAMP_UP_UNTIL ?? null,
      send_ramp_up_active: (() => {
        const t = env.SEND_RAMP_UP_UNTIL ? Date.parse(env.SEND_RAMP_UP_UNTIL) : NaN;
        return Number.isFinite(t) && Date.now() < t;
      })(),
      bubble_combine: env.BUBBLE_COMBINE,
      node_env: env.NODE_ENV,
      booted_at: process.env.PEACHBOT_BOOTED_AT ?? "(unknown)",
    });
  }

  if (method === "GET" && path === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(renderMetrics());
    return;
  }

  // ─── webhook ingress (signature-gated OR IP-gated when no signature) ──
  // Platform POSTs deliveries here. Every payload carries its own account id
  // so this endpoint is truly multi-tenant: one URL, N creators.
  //
  // Two URL paths supported:
  //   /webhooks/platform     — original / generic
  //   /webhooks/onlyfansapi  — alias matching what we configured on the
  //                            OFAPI dashboard tunnel URL
  //
  // Trust:
  //   - If PLATFORM_WEBHOOK_SECRET is set → adapter verifies HMAC signature.
  //   - Else if PLATFORM_WEBHOOK_TRUSTED_IPS is set → require source IP match.
  //   - Else (dev mode) → accept all (with a logged warning).
  if (method === "POST" && (path === "/webhooks/platform" || path === "/webhooks/onlyfansapi")) {
    const sourceIp = clientIp(req);
    const trustOk = trustedSource(sourceIp);
    if (!trustOk) {
      logger.warn({ sourceIp, path }, "webhook rejected: source ip not in trusted list");
      recordWebhookEvent({
        at: new Date().toISOString(),
        path,
        sourceIp,
        trusted: false,
        parsed: 0,
        enqueued: 0,
        blockedByAllowlist: 0,
        unknownAccounts: 0,
      });
      return text(res, 403, "untrusted source");
    }

    // Webhook ingress is BEST-EFFORT and ALWAYS returns 200 to OFAPI (unless
    // signature/IP gate fails). Per-event failures (DB pool exhaustion, parse
    // errors, queue add failures) are logged but don't surface as 500s,
    // because:
    //   1. A 500 makes OFAPI retry the same event up to 3x — multiplying load
    //      under the exact pressure that caused the original failure.
    //   2. Idempotency keys mean a successful retry would still de-dupe, so
    //      retries don't help anyway when the issue is capacity.
    //   3. We'd rather drop one occasional event than cascade-fail the queue.
    let rawBody: string;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "webhook readRawBody failed");
      return json(res, 200, { received: 0, error: "body_read_failed" });
    }

    const adapter = getPlatformAdapter();
    let events;
    try {
      events = adapter.parseWebhook({ rawBody, headers: req.headers });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "webhook parseWebhook threw");
      recordWebhookEvent({
        at: new Date().toISOString(),
        path,
        sourceIp,
        trusted: true,
        parsed: 0,
        enqueued: 0,
        blockedByAllowlist: 0,
        unknownAccounts: 0,
        parseError: msg,
      });
      return json(res, 200, { received: 0, error: "parse_failed" });
    }
    if (events === null) {
      recordWebhookEvent({
        at: new Date().toISOString(),
        path,
        sourceIp,
        trusted: true,
        parsed: 0,
        enqueued: 0,
        blockedByAllowlist: 0,
        unknownAccounts: 0,
        signatureInvalid: true,
      });
      return text(res, 401, "invalid signature");
    }

    let enqueued = 0;
    let autoCreated = 0;
    let unknownAccounts = 0;
    let blockedByAllowlist = 0;
    let perEventErrors = 0;
    const allowlist = parseAllowlist();
    for (const event of events) {
      try {
        if (allowlist && !allowlist.has(event.platformAccountId)) {
          blockedByAllowlist++;
          continue;
        }

        let account = await loadAccountByPlatformId("onlyfans", event.platformAccountId);
        if (!account) {
          if (env.SHADOW_MODE) {
            account = await upsertShadowAccount({
              platform: "onlyfans",
              platformAccountId: event.platformAccountId,
            });
            autoCreated++;
            logger.info(
              { platformAccountId: event.platformAccountId, accountId: account.id },
              "shadow auto-created account row for incoming webhook",
            );
          } else {
            unknownAccounts++;
            logger.warn({ platformAccountId: event.platformAccountId }, "webhook for unknown account");
            continue;
          }
        }
        await inboundQueue().add(
          event.kind,
          { accountId: account.id, event: serializeEvent(event) },
          { jobId: `${event.kind}-${event.externalId}` },
        );
        enqueued++;
      } catch (err) {
        // One event failed — log and continue with the rest. Most likely
        // cause: Postgres pool exhaustion under burst load, or Redis hiccup.
        perEventErrors++;
        logger.error(
          {
            err: err instanceof Error ? err.message : err,
            stack: err instanceof Error ? err.stack : undefined,
            platformAccountId: event.platformAccountId,
            eventKind: event.kind,
            externalId: event.externalId,
          },
          "webhook event handling failed (continuing)",
        );
      }
    }
    recordWebhookEvent({
      at: new Date().toISOString(),
      path,
      sourceIp,
      trusted: true,
      parsed: events.length,
      enqueued,
      blockedByAllowlist,
      unknownAccounts,
    });
    return json(res, 200, {
      received: events.length,
      enqueued,
      autoCreated,
      unknownAccounts,
      blockedByAllowlist,
      ...(perEventErrors ? { errors: perEventErrors } : {}),
    });
  }

  if (path.startsWith("/admin")) {
    if (!token) return text(res, 503, "admin disabled (ADMIN_TOKEN unset)");
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) return text(res, 401, "unauthorized");

    const takeoverMatch = /^\/admin\/conversations\/([^/]+)\/takeover\/(on|off)$/.exec(path);
    if (method === "POST" && takeoverMatch) {
      const [, convId, action] = takeoverMatch;
      if (action === "on") await enableTakeover(convId as string);
      else await disableTakeover(convId as string);
      return json(res, 200, { conversationId: convId, takeover: action === "on" });
    }

    const takeoverStatus = /^\/admin\/conversations\/([^/]+)\/takeover$/.exec(path);
    if (method === "GET" && takeoverStatus) {
      const [, convId] = takeoverStatus;
      return json(res, 200, {
        conversationId: convId,
        takeover: await isTakenOver(convId as string),
      });
    }

    const whyMatch = /^\/admin\/conversations\/([^/]+)\/why$/.exec(path);
    if (method === "GET" && whyMatch) {
      const [, convId] = whyMatch;
      return json(res, 200, await loadLastTurnAudit(convId as string));
    }

    // POST /admin/drain-nudges
    //   - Pauses the outbound queue
    //   - Removes ALL waiting + delayed jobs whose name === "nudge" or
    //     whose jobId begins with "nudge-"
    //   - Resumes the queue
    // Panic button: user disabled NUDGE_ENABLED but pre-existing queued
    // jobs are still draining and hitting fans. This stops them in flight.
    if (method === "POST" && path === "/admin/drain-nudges") {
      try {
        const q = outboundQueue();
        await q.pause();
        const [waiting, delayed] = await Promise.all([
          q.getWaiting(0, 1000),
          q.getDelayed(0, 1000),
        ]);
        const all = [...waiting, ...delayed];
        let removed = 0;
        const keptNonNudge: number[] = [];
        for (const job of all) {
          const isNudge = job.name === "nudge" || (typeof job.id === "string" && job.id.startsWith("nudge-"));
          if (!isNudge) continue;
          try {
            await job.remove();
            removed++;
          } catch (err) {
            keptNonNudge.push(Number(job.id));
            logger.warn(
              { jobId: job.id, err: err instanceof Error ? err.message : err },
              "drain-nudges: failed to remove job",
            );
          }
        }
        await q.resume();
        return json(res, 200, {
          inspected: all.length,
          removed,
          failures: keptNonNudge.length,
          note: "outbound queue paused, nudge-tagged jobs removed, queue resumed.",
        });
      } catch (err) {
        return json(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // POST /admin/bulk-unsend?sinceMinutes=N[&accountId=X][&kind=text|ppv|any][&dryRun=false]
    //
    // Bulk-deletes outbound messages on the platform side (OFAPI DELETE).
    // Built for the operator panic case: nudge worker (or any other path)
    // floods fans with messages that need to be unsent at scale. Calls
    // adapter.deleteMessage for each match.
    //
    // Defaults:
    //   - sinceMinutes capped at 1440 (OFAPI restriction: only messages
    //     <24h old can be deleted)
    //   - dryRun=true by default; pass dryRun=false to actually fire
    //   - kind=text by default (catches nudges + plain chat replies);
    //     pass kind=any to include PPVs, or kind=ppv for only PPVs
    //   - max 500 rows per call; rerun for bigger backlogs
    //
    // Returns the list of matched messages with text preview so you can
    // sanity-check before running with dryRun=false.
    if (method === "POST" && path === "/admin/bulk-unsend") {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const sinceMinutes = Math.min(
        1440,
        Math.max(1, Number(url.searchParams.get("sinceMinutes") ?? 30)),
      );
      const accountIdFilter = url.searchParams.get("accountId");
      const kindParam = (url.searchParams.get("kind") ?? "text").toLowerCase();
      const dryRun = url.searchParams.get("dryRun") !== "false";

      const cutoff = new Date(Date.now() - sinceMinutes * 60_000);

      let q = db
        .selectFrom("v3.messages as m")
        .innerJoin("v3.conversations as c", "c.id", "m.conversation_id")
        .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
        .select([
          "m.id as message_id",
          "m.external_id as external_id",
          "m.kind as kind",
          "m.created_at as created_at",
          "m.sent_at as sent_at",
          "m.text as text",
          "c.id as conversation_id",
          "c.account_id as account_id",
          "s.external_id as fan_external_id",
          "s.display_name as display_name",
        ])
        .where("m.direction", "=", "outbound")
        .where("m.external_id", "is not", null)
        .where(sql<SqlBool>`m.sent_at >= ${cutoff}`)
        .where(sql<SqlBool>`m.external_id NOT LIKE 'shadow:%'`)
        .orderBy("m.sent_at", "desc")
        .limit(500);

      if (accountIdFilter) {
        q = q.where("c.account_id", "=", accountIdFilter);
      }
      if (kindParam !== "any") {
        // kindParam is one of "text" | "ppv" | "unlock" | "tip" | "subscription" | "system_event"
        // Validate to satisfy the kysely enum type — fall back to "text" silently.
        const validKinds = ["text", "ppv", "unlock", "tip", "subscription", "system_event"] as const;
        type ValidKind = (typeof validKinds)[number];
        const safeKind: ValidKind = (validKinds as readonly string[]).includes(kindParam)
          ? (kindParam as ValidKind)
          : "text";
        q = q.where("m.kind", "=", safeKind);
      }

      const rows = await q.execute();

      if (dryRun) {
        return json(res, 200, {
          dryRun: true,
          sinceMinutes,
          kind: kindParam,
          accountId: accountIdFilter,
          found: rows.length,
          messages: rows.map((r) => ({
            messageId: r.message_id,
            externalId: r.external_id,
            kind: r.kind,
            sentAt: r.sent_at,
            displayName: r.display_name,
            fanExternalId: r.fan_external_id,
            textPreview: ((r.text ?? "") as string).slice(0, 120),
          })),
          note:
            "dry-run only — no platform deletes fired. Re-run with &dryRun=false to actually unsend.",
        });
      }

      // Execute deletes. adapter.deleteMessage swallows OFAPI failures
      // (24h limit, 404, etc.) by design — we still count attempts so
      // the operator knows what we tried.
      const adapter = getPlatformAdapter();
      let attempted = 0;
      const skipped: Array<{ messageId: string; reason: string }> = [];

      for (const row of rows) {
        try {
          const account = await loadAccountById(row.account_id);
          if (!account?.platformAccountId) {
            skipped.push({ messageId: row.message_id, reason: "account missing platform_account_id" });
            continue;
          }
          if (!row.external_id) {
            skipped.push({ messageId: row.message_id, reason: "no external_id" });
            continue;
          }
          await adapter.deleteMessage(
            { accountId: row.account_id, platformAccountId: account.platformAccountId },
            { chatId: row.fan_external_id, messageExternalId: row.external_id },
          );
          attempted++;
        } catch (err) {
          skipped.push({
            messageId: row.message_id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return json(res, 200, {
        dryRun: false,
        sinceMinutes,
        kind: kindParam,
        accountId: accountIdFilter,
        found: rows.length,
        attempted,
        skipped,
        note:
          "adapter.deleteMessage is best-effort; OFAPI returns errors for messages >24h old which the adapter swallows. Successful sends are not separately confirmed — re-run as dryRun=true to see what's still listed.",
      });
    }

    // POST /admin/mass-caption?account=<creator_uuid_or_platform_id>[&vibe=tease|sweet|chaotic|...]
    // Returns ONE freshly-generated mass-message caption in the v1.8 pick-me
    // voice. Replaces n8n's static `mass_captions_onlyfans` rotation with
    // grok-4.1 reasoning. Per-account Redis ring of last 20 captions stops
    // the model from accidentally repeating itself across hours.
    //
    // Optional ?vibe locks the angle (mood / tease / soft / chaotic /
    // scarcity / question / horny / playful / sweet). Without it, the model
    // picks from the rotation freely.
    if (method === "POST" && path === "/admin/mass-caption") {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const accountParam = (url.searchParams.get("account") ?? "").trim();
      if (!accountParam) {
        return json(res, 400, { error: "account query param required (creator_uuid or platform_account_id)" });
      }
      // n8n stores creatoruuid which OFAPI uses as both the account ref AND
      // the platform_account_id. Try both lookups so either form works.
      const account =
        (await loadAccountByCreatorUuid(accountParam)) ??
        (await loadAccountByPlatformId("onlyfans", accountParam));
      if (!account) {
        return json(res, 404, { error: `no account matched ${accountParam}` });
      }
      const vibeParam = url.searchParams.get("vibe");
      const vibe = vibeParam && isValidVibe(vibeParam) ? vibeParam : null;
      try {
        const result = await generateMassCaption({
          accountId: account.id,
          vibe,
          hourOfDay: new Date().getHours(),
        });
        return json(res, 200, result);
      } catch (err) {
        return json(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // POST /admin/halt-fan?name=ari        — find by display_name (ILIKE)
    // POST /admin/halt-fan?external_id=X   — find by platform external id
    // POST /admin/halt-fan?name=ari&action=off — re-enable bot replies
    // Looks up the subscriber's conversation(s) and flips operator takeover.
    // Saves you from needing to find UUIDs first when a fan is misbehaving
    // (e.g. another bot, two bots looping, abuse, manual handover).
    if (method === "POST" && path === "/admin/halt-fan") {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const name = url.searchParams.get("name")?.trim() || null;
      const externalId = url.searchParams.get("external_id")?.trim() || null;
      const action = (url.searchParams.get("action") ?? "on").toLowerCase();
      if (!name && !externalId) {
        return json(res, 400, { error: "must provide ?name= or ?external_id=" });
      }
      // Match by either display_name (case-insensitive substring) or external_id.
      const subs = await db
        .selectFrom("v3.subscribers")
        .select(["id", "external_id", "display_name", "account_id"])
        .where((eb) => {
          if (externalId) return eb("external_id", "=", externalId);
          return sql<SqlBool>`lower(display_name) like ${"%" + (name ?? "").toLowerCase() + "%"}`;
        })
        .limit(20)
        .execute();
      if (subs.length === 0) {
        return json(res, 404, { error: "no subscriber matched" });
      }
      const flipped: Array<{
        subscriberId: string;
        externalId: string | null;
        displayName: string | null;
        conversationId: string;
        action: "on" | "off";
      }> = [];
      for (const s of subs) {
        const conv = await db
          .selectFrom("v3.conversations")
          .select(["id"])
          .where("subscriber_id", "=", s.id)
          .orderBy("last_activity_at", "desc")
          .limit(1)
          .executeTakeFirst();
        if (!conv) continue;
        if (action === "off") await disableTakeover(conv.id);
        else await enableTakeover(conv.id);
        flipped.push({
          subscriberId: s.id,
          externalId: s.external_id,
          displayName: s.display_name,
          conversationId: conv.id,
          action: action === "off" ? "off" : "on",
        });
      }
      return json(res, 200, { matched: subs.length, flipped });
    }

    if (method === "GET" && path === "/admin/threads") {
      return json(res, 200, await loadThreads());
    }

    const threadDetailMatch = /^\/admin\/threads\/([^/]+)$/.exec(path);
    if (method === "GET" && threadDetailMatch) {
      const [, convId] = threadDetailMatch;
      return json(res, 200, await loadThread(convId as string));
    }

    // GET /admin/conversations/:id/pitch-state — operator visibility into:
    //   - current phase + turns
    //   - drip cadence countdown ("X / 10 turns until next drip pitch")
    //   - what asset the picker would hand back next turn
    //   - funnel state for that asset (none / preview_sent / ppv_sent)
    //   - recent pitch attempts + outcomes
    //   - purchase history (script, rung, amount, when)
    // Useful for shadow-mode operation: see what the bot WOULD do without
    // having to read code. Surfaces all the gates that decide pitch firing.
    const pitchStateMatch = /^\/admin\/conversations\/([^/]+)\/pitch-state$/.exec(path);
    if (method === "GET" && pitchStateMatch) {
      const [, convId] = pitchStateMatch;
      return json(res, 200, await loadPitchState(convId as string));
    }

    // Simulate a fan purchasing a PPV. Fires a synthetic ppv.unlocked event
    // through the inbound queue so the normal handlePpvUnlocked pipeline
    // runs end-to-end (attempt resolved, asset_performance bumped,
    // purchases_onlyfans row written so the next pitch advances the ladder).
    if (method === "POST" && path === "/admin/test/ppv-unlock") {
      const body = await readBody(req);
      const { conversationId, messageId } = body as Record<string, unknown>;
      if (typeof conversationId !== "string" || !conversationId) {
        return json(res, 400, { error: "conversationId required" });
      }
      if (typeof messageId !== "string" || !messageId) {
        return json(res, 400, { error: "messageId required" });
      }

      // Load the conversation + subscriber + attempt in parallel.
      const [convRow, attemptRow] = await Promise.all([
        db
          .selectFrom("v3.conversations as c")
          .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
          .select([
            "c.id as conversation_id",
            "c.account_id as account_id",
            "s.external_id as subscriber_external_id",
          ])
          .where("c.id", "=", conversationId)
          .executeTakeFirst(),
        db
          .selectFrom("v3.ppv_attempts as a")
          .innerJoin("v3.ppv_catalog as c", "c.id", "a.asset_id")
          .select([
            "a.id as attempt_id",
            "a.price_cents as price_cents",
            "a.outcome as outcome",
            "c.source_ref as source_ref",
          ])
          .where("a.message_id", "=", messageId)
          .executeTakeFirst(),
      ]);

      if (!convRow) return json(res, 404, { error: "conversation not found" });
      if (!attemptRow) return json(res, 404, { error: "no ppv attempt for that message" });
      if (attemptRow.outcome !== "pending") {
        return json(res, 409, { error: `already ${attemptRow.outcome}` });
      }

      const event = serializeEvent({
        externalId: `test-unlock-${randomUUID()}`,
        kind: "ppv.unlocked",
        platformAccountId: "test",
        subscriberExternalId: convRow.subscriber_external_id,
        payload: {
          price_cents: Number(attemptRow.price_cents),
          asset_ref: attemptRow.source_ref ?? null,
          isTest: true,
        },
        occurredAt: new Date(),
      });

      await inboundQueue().add(
        "ppv.unlocked",
        { accountId: convRow.account_id, event },
        { jobId: event.externalId },
      );

      logger.info(
        { conversationId, messageId, attemptId: attemptRow.attempt_id },
        "test ppv unlock injected",
      );
      return json(res, 200, {
        ok: true,
        externalId: event.externalId,
        attemptId: attemptRow.attempt_id,
        priceCents: Number(attemptRow.price_cents),
      });
    }

    // Unread fans on the platform — proxies OFAPI's chats?filter=unread for the
    // allowlisted account so the dashboard can show fans who messaged but
    // V3 didn't reply (dropped during 429 cascades, missed during outages,
    // or arrived before our webhook URL was wired). Read-only.
    if (method === "GET" && path === "/admin/unread-fans") {
      const platformAccountId = env.PLATFORM_ACCOUNT_ALLOWLIST?.split(",")[0]?.trim();
      if (!platformAccountId) {
        return json(res, 400, { error: "no PLATFORM_ACCOUNT_ALLOWLIST set" });
      }
      try {
        const apiBase = env.PLATFORM_API_BASE;
        const apiKey = env.PLATFORM_API_KEY;
        if (!apiBase || !apiKey) return json(res, 500, { error: "PLATFORM_API_BASE / PLATFORM_API_KEY missing" });
        // Match n8n / browser request shape — see client.ts comment.
        const r = await fetch(
          `${apiBase}/api/${platformAccountId}/chats?filter=unread&limit=50&skip_users=none&order=recent`,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept:
                "application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, image/*;q=0.8, */*;q=0.7",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
              "Accept-Encoding": "gzip, deflate, br",
            },
          },
        );
        if (!r.ok) {
          const errBody = await r.text().catch(() => "");
          // Surface Retry-After so the dashboard can show a smart "try again
          // in N seconds" message instead of generic error. OFAPI sends this
          // header on 429s per their 2026-04-28 guidance.
          const retryAfterRaw = r.headers.get("retry-after");
          const retryAfterMs = parseRetryAfter(retryAfterRaw);
          return json(res, 502, {
            error: `ofapi ${r.status}`,
            body: errBody.slice(0, 500),
            ...(retryAfterRaw ? { retryAfterHeaderRaw: retryAfterRaw } : {}),
            ...(retryAfterMs != null ? { retryAfterMs } : {}),
          });
        }
        const data = (await r.json()) as { data?: Array<Record<string, unknown>> };
        // Distill to just what the dashboard needs to render + decide.
        // FILTER OUT mass-message chats: when a creator sends a mass DM, every
        // recipient's chat shows as "unread" from OFAPI's perspective even
        // though the creator was the LAST sender. Those don't represent
        // missed fan messages — the dashboard's "Send V3 reply" button is
        // for fans who messaged US that we haven't replied to. Filter to
        // chats whose last message was from the FAN (fromUser.id === fan.id).
        const out = (data.data ?? [])
          .map((chat) => {
            const lastMessage = (chat.lastMessage ?? {}) as Record<string, unknown>;
            const fan = (chat.fan ?? {}) as Record<string, unknown>;
            const fromUser = (lastMessage.fromUser ?? {}) as Record<string, unknown>;
            const lastFromUserId = Number(fromUser.id ?? 0);
            const fanId = Number(fan.id ?? 0);
            // Detect mass-message chats two ways:
            //   1. lastMessage.fromUser is the creator (fromUser.id !== fan.id)
            //   2. lastMessage.isFromQueue / .isFree / .price flags often set on broadcasts
            const isFromFan = lastFromUserId !== 0 && fanId !== 0 && lastFromUserId === fanId;
            const isMassBroadcast =
              lastMessage.isFromQueue === true ||
              (typeof (lastMessage.queueId as unknown) === "string" && (lastMessage.queueId as string).length > 0);
            return {
              fanExternalId: String(fan.id ?? fromUser.id ?? ""),
              fanName: String(fan.name ?? fan.username ?? ""),
              fanUsername: String(fan.username ?? ""),
              fanAvatar: (fan.avatar as string | null) ?? null,
              unreadCount: Number(chat.unreadMessagesCount ?? 0),
              lastMessageId: String(lastMessage.id ?? ""),
              lastMessageText: String(lastMessage.text ?? ""),
              lastMessageAt: String(lastMessage.createdAt ?? ""),
              isFromFan,
              isMassBroadcast,
            };
          })
          // Only fans whose LAST message was from the fan AND not a mass-message
          // tail. The dashboard's catch-up button only makes sense for these.
          .filter((c) => c.isFromFan && !c.isMassBroadcast);
        return json(res, 200, { unread: out });
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Trigger V3 to generate + send a reply for a real fan inbound that
    // wasn't processed (e.g. dropped during 429 cascade). Synthesizes a
    // messages.received event and runs it through the same pipeline as a
    // real webhook — the dashboard wires this to a "Send V3 reply" button.
    if (method === "POST" && path === "/admin/trigger-fan-reply") {
      const body = await readBody(req);
      const {
        fanExternalId,
        platformAccountId: pAcctId,
        text: msgText,
        messageId: msgIdInput,
        fanName,
      } = body as Record<string, unknown>;
      if (typeof fanExternalId !== "string" || !fanExternalId) {
        return json(res, 400, { error: "fanExternalId required" });
      }
      if (typeof msgText !== "string") {
        return json(res, 400, { error: "text required" });
      }
      const platformAccountId =
        typeof pAcctId === "string" && pAcctId.length > 0
          ? pAcctId
          : env.PLATFORM_ACCOUNT_ALLOWLIST?.split(",")[0]?.trim();
      if (!platformAccountId) {
        return json(res, 400, { error: "platformAccountId required (no allowlist default)" });
      }

      // Look up the internal account by platform id. If missing, refuse —
      // this isn't shadow-mode auto-create territory.
      const account = await loadAccountByPlatformId("onlyfans", platformAccountId);
      if (!account) {
        return json(res, 404, { error: `no account row for ${platformAccountId}` });
      }

      const event = serializeEvent({
        externalId: `manual-trigger-${randomUUID()}`,
        kind: "message.received",
        platformAccountId,
        subscriberExternalId: fanExternalId,
        conversationExternalId: fanExternalId,
        payload: {
          // Mirror the fields parseWebhook normalises — already-extracted
          // text + the original payload style for downstream tools that read
          // payload.text.
          text: msgText,
          fromUser: { id: Number.isFinite(Number(fanExternalId)) ? Number(fanExternalId) : fanExternalId, name: fanName ?? "" },
          id: typeof msgIdInput === "string" ? msgIdInput : `manual-${Date.now()}`,
          createdAt: new Date().toISOString(),
          isManualTrigger: true,
        },
        occurredAt: new Date(),
      });

      await inboundQueue().add(
        event.kind,
        { accountId: account.id, event },
        { jobId: `${event.kind}-${event.externalId}` },
      );
      logger.info(
        { fanExternalId, platformAccountId, accountId: account.id },
        "manual fan-reply trigger enqueued",
      );
      return json(res, 200, { ok: true, externalId: event.externalId, accountId: account.id });
    }

    // Re-queue turn jobs for conversations where the fan's last message is
    // INBOUND but no bot reply happened (orphaned by an earlier worker
    // failure such as the SEXTING enum bug). Useful after a structural fix
    // ships and we need to drain the backlog of fans waiting for replies.
    //
    // POST body (optional): { maxAgeMinutes?: number }  default 120 min.
    // Won't replay convs older than that to avoid spamming long-cold fans.
    //
    // Idempotent — same jobId per conv, BullMQ will deduplicate if a turn
    // is already queued for that conv.
    if (method === "POST" && path === "/admin/replay-stuck-convs") {
      const body = await readBody(req).catch(() => ({}));
      const rawMax = (body as Record<string, unknown>).maxAgeMinutes;
      const maxAgeMinutes: number = typeof rawMax === "number" && Number.isFinite(rawMax) ? rawMax : 120;
      try {
        const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
        // Find conversations whose latest message is inbound AND newer than cutoff.
        const stuck = await db
          .selectFrom("v3.conversations as c")
          .innerJoin(
            db
              .selectFrom("v3.messages")
              .select(["conversation_id", "direction", "created_at"])
              .distinctOn(["conversation_id"])
              .orderBy("conversation_id")
              .orderBy("created_at", "desc")
              .as("latest"),
            "latest.conversation_id",
            "c.id",
          )
          .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
          .select([
            "c.id as conversationId",
            "c.account_id as accountId",
            "c.subscriber_id as subscriberId",
            "s.external_id as subscriberExternalId",
            "latest.created_at as lastMessageAt",
          ])
          .where("latest.direction", "=", "inbound")
          .where(sql<SqlBool>`latest.created_at > ${cutoff}`)
          .execute();

        let queued = 0;
        for (const row of stuck) {
          await turnQueue().add(
            "turn",
            {
              accountId: row.accountId as string,
              conversationId: row.conversationId as string,
              subscriberId: row.subscriberId as string,
              subscriberExternalId: row.subscriberExternalId as string,
            },
            { jobId: `turn-${row.conversationId}`, delay: 1000 },
          );
          queued++;
        }
        return json(res, 200, {
          ok: true,
          maxAgeMinutes,
          stuckCount: stuck.length,
          queued,
          conversations: stuck.map((r) => ({
            convId: r.conversationId,
            subExt: r.subscriberExternalId,
            lastMessageAt: (r.lastMessageAt as unknown as Date)?.toISOString?.() ?? r.lastMessageAt,
          })),
        });
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (method === "POST" && path === "/admin/test/inject") {
      const body = await readBody(req);
      const { subscriberExternalId, text: msgText, subscriberName, accountId: overrideAccountId } = body as Record<string, unknown>;
      if (typeof subscriberExternalId !== "string" || !subscriberExternalId) {
        return json(res, 400, { error: "subscriberExternalId required" });
      }
      if (typeof msgText !== "string" || !msgText.trim()) {
        return json(res, 400, { error: "text required" });
      }
      // Test isolation: callers (e.g. the auto-improve loop) can pass a
      // dedicated test accountId so test conversations land in a separate
      // account that the Home Tab does not query. Falls back to the worker's
      // configured account when omitted (preserves existing behaviour for the
      // V3 Testing Ground tab).
      const targetAccountId =
        typeof overrideAccountId === "string" && overrideAccountId.length > 0
          ? overrideAccountId
          : env.ACCOUNT_ID;
      const event = serializeEvent({
        externalId: `test-${randomUUID()}`,
        kind: "message.received",
        platformAccountId: "test",
        subscriberExternalId,
        payload: {
          text: msgText.trim(),
          subscriberName: subscriberName ?? subscriberExternalId,
          isTest: true,
        },
        occurredAt: new Date(),
      });

      await inboundQueue().add(
        "inbound",
        { accountId: targetAccountId, event },
        { jobId: event.externalId },
      );
      logger.info({ subscriberExternalId, text: msgText.trim(), accountId: targetAccountId }, "test event injected");
      return json(res, 200, { ok: true, externalId: event.externalId, accountId: targetAccountId });
    }
  }

  return text(res, 404, "not found");
}

async function loadThreads(): Promise<unknown> {
  const rows = await db
    .selectFrom("v3.conversations as c")
    .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
    .innerJoin("v3.accounts as a", "a.id", "c.account_id")
    .select([
      "c.id as conversation_id",
      "c.phase as phase",
      "c.substate as substate",
      "c.last_activity_at as last_activity_at",
      "c.account_id as account_id",
      "s.id as subscriber_id",
      "s.external_id as subscriber_external_id",
      "s.display_name as display_name",
      "a.platform_account_id as platform_account_id",
      "a.config as account_config",
    ])
    .orderBy("c.last_activity_at", "desc")
    .limit(200)
    .execute();

  const convIds = rows.map((r) => r.conversation_id);
  if (convIds.length === 0) return { threads: [] };

  const lastMessages = await db
    .selectFrom("v3.messages")
    .select(["conversation_id", "direction", "kind", "text", "created_at"])
    .where("conversation_id", "in", convIds)
    .orderBy("created_at", "desc")
    .execute();

  const lastByConv = new Map<string, (typeof lastMessages)[number]>();
  for (const m of lastMessages) {
    if (!lastByConv.has(m.conversation_id)) lastByConv.set(m.conversation_id, m);
  }

  // Source classifier — used by the dashboard to split conversations into:
  //   "test"       — synthetic loop testers (the seeded TEST_ACCOUNT_ID)
  //   "shadow"     — real OFAPI traffic, observed but not replied to
  //   "production" — real OFAPI traffic with full reply (future state)
  // Frontend shows them in different sections + colour codes the badges.
  const TEST_ACCOUNT_ID = "00000000-0000-0000-0000-00000000beef";

  const threads = rows.map((r) => {
    // Source label tracks RUNTIME behavior — what's the bot actually doing
    // for this account right now, not what mode the account was created in:
    //   - "test"       = synthetic loop tester OR missing platform_account_id
    //   - "shadow"     = SHADOW_MODE env is true → bot never sends replies
    //   - "production" = SHADOW_MODE env is false → bot replies for real
    // Reading env.SHADOW_MODE means the label flips correctly the moment we
    // toggle the env var, even if the account row's config.shadow was set
    // historically during a prior shadow-mode auto-create.
    const isTest = r.account_id === TEST_ACCOUNT_ID;
    const hasPlatformId = Boolean(r.platform_account_id);
    const source: "test" | "shadow" | "production" =
      isTest || !hasPlatformId
        ? "test"
        : env.SHADOW_MODE
          ? "shadow"
          : "production";

    return {
      conversationId: r.conversation_id,
      subscriberId: r.subscriber_id,
      subscriberExternalId: r.subscriber_external_id,
      displayName: r.display_name,
      phase: r.phase,
      substate: r.substate,
      lastActivityAt: r.last_activity_at,
      accountId: r.account_id,
      platformAccountId: r.platform_account_id,
      source,
      lastMessage: lastByConv.get(r.conversation_id)
        ? {
            direction: lastByConv.get(r.conversation_id)!.direction,
            kind: lastByConv.get(r.conversation_id)!.kind,
            text: lastByConv.get(r.conversation_id)!.text,
            createdAt: lastByConv.get(r.conversation_id)!.created_at,
          }
        : null,
    };
  });
  return { threads };
}

async function loadThread(conversationId: string): Promise<unknown> {
  const conv = await db
    .selectFrom("v3.conversations as c")
    .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
    .select([
      "c.id as conversation_id",
      "c.phase as phase",
      "c.substate as substate",
      "c.turns_in_phase as turns_in_phase",
      "c.last_activity_at as last_activity_at",
      "s.id as subscriber_id",
      "s.external_id as subscriber_external_id",
      "s.display_name as display_name",
      "s.total_spend_cents as total_spend_cents",
      "s.spend_30d_cents as spend_30d_cents",
    ])
    .where("c.id", "=", conversationId)
    .executeTakeFirst();

  if (!conv) return { found: false };

  const messages = await db
    .selectFrom("v3.messages")
    .select(["id", "direction", "kind", "text", "created_at", "sent_at", "llm_call_id"])
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at", "asc")
    .limit(200)
    .execute();

  // Join ppv_attempts + catalog for any PPV messages so the UI can render a
  // real card (price, caption, buy button). One query, indexed by message id.
  const ppvMessageIds = messages.filter((m) => m.kind === "ppv").map((m) => m.id);
  const ppvByMessage = new Map<
    string,
    {
      attemptId: string;
      priceCents: number;
      outcome: string;
      unlockedAt: Date | null;
      assetId: string;
      assetTitle: string;
      assetDescription: string | null;
      sourceRef: string | null;
      mediaRefs: unknown[];
    }
  >();
  if (ppvMessageIds.length > 0) {
    const rows = await db
      .selectFrom("v3.ppv_attempts as a")
      .innerJoin("v3.ppv_catalog as c", "c.id", "a.asset_id")
      .select([
        "a.id as attempt_id",
        "a.message_id as message_id",
        "a.price_cents as price_cents",
        "a.outcome as outcome",
        "a.unlocked_at as unlocked_at",
        "c.id as asset_id",
        "c.title as asset_title",
        "c.description as asset_description",
        "c.source_ref as source_ref",
        "c.media_refs as media_refs",
      ])
      .where("a.message_id", "in", ppvMessageIds)
      .execute();
    for (const r of rows) {
      if (!r.message_id) continue;
      ppvByMessage.set(r.message_id, {
        attemptId: r.attempt_id,
        priceCents: Number(r.price_cents),
        outcome: r.outcome,
        unlockedAt: (r.unlocked_at as Date | null) ?? null,
        assetId: r.asset_id,
        assetTitle: r.asset_title,
        assetDescription: r.asset_description,
        sourceRef: r.source_ref ?? null,
        mediaRefs: Array.isArray(r.media_refs) ? r.media_refs : [],
      });
    }
  }

  const [archetypeRow] = await db
    .selectFrom("v3.archetypes")
    .select(["spender_tier", "engagement_level", "relationship_tone", "price_sensitivity", "fetish_tags", "classified_at"])
    .where("subscriber_id", "=", conv.subscriber_id)
    .orderBy("classified_at", "desc")
    .limit(1)
    .execute();

  return {
    found: true,
    conversation: {
      conversationId: conv.conversation_id,
      subscriberId: conv.subscriber_id,
      subscriberExternalId: conv.subscriber_external_id,
      displayName: conv.display_name,
      phase: conv.phase,
      substate: conv.substate,
      turnsInPhase: conv.turns_in_phase,
      lastActivityAt: conv.last_activity_at,
      totalSpendCents: Number(conv.total_spend_cents ?? 0),
      spend30dCents: Number(conv.spend_30d_cents ?? 0),
    },
    archetype: archetypeRow
      ? {
          spenderTier: archetypeRow.spender_tier,
          engagementLevel: archetypeRow.engagement_level,
          relationshipTone: archetypeRow.relationship_tone,
          priceSensitivity: archetypeRow.price_sensitivity,
          fetishTags: archetypeRow.fetish_tags ?? [],
          classifiedAt: archetypeRow.classified_at,
        }
      : null,
    messages: messages.map((m) => {
      const ppv = ppvByMessage.get(m.id);
      return {
        id: m.id,
        direction: m.direction,
        kind: m.kind,
        text: m.text,
        createdAt: m.created_at,
        sentAt: m.sent_at,
        llmCallId: m.llm_call_id,
        ppv: ppv ?? null,
      };
    }),
  };
}

/**
 * Pitch-state diagnostic for a conversation. Surfaces every gate the
 * orchestrator considers when deciding to fire a PPV, plus the fan's
 * actual unlock history. Read-only — does not enqueue or change state.
 *
 * Note: pickNextForFan has a side effect (idempotent upsert into
 * v3.ppv_catalog mirror table). That's fine to fire on a peek; the
 * row would have been written on the next real pitch turn anyway.
 */
async function loadPitchState(conversationId: string): Promise<unknown> {
  const conv = await db
    .selectFrom("v3.conversations as c")
    .innerJoin("v3.subscribers as s", "s.id", "c.subscriber_id")
    .select([
      "c.id as conversation_id",
      "c.account_id as account_id",
      "c.phase as phase",
      "c.turns_in_phase as turns_in_phase",
      "c.last_activity_at as last_activity_at",
      "s.id as subscriber_id",
      "s.external_id as subscriber_external_id",
      "s.display_name as display_name",
    ])
    .where("c.id", "=", conversationId)
    .executeTakeFirst();
  if (!conv) return { found: false };

  const account = await loadAccountById(conv.account_id);

  // Drip + cooldown signals.
  const turnsSinceLast = await ppvTurnsSinceLastPitch(conversationId);
  // Threshold + lookback MUST mirror orchestrator's UNBOUGHT_LOOKBACK
  // (currently 1). When you change it there, change it here too — the panel
  // reads as a lie otherwise.
  const unboughtThreshold = 1;
  const unbought = await countUnboughtRecentPitches({
    conversationId,
    lookback: unboughtThreshold,
    inboundSince: 2,
  });

  // Recent attempts joined with catalog so the UI can show script/rung.
  const recentAttempts = await listRecentAttempts(conversationId, 10);
  const attemptCatalogRows = recentAttempts.length > 0
    ? await db
        .selectFrom("v3.ppv_catalog")
        .select(["id", "title", "source_ref"])
        .where("id", "in", recentAttempts.map((a) => a.assetId))
        .execute()
    : [];
  const catalogById = new Map(attemptCatalogRows.map((r) => [r.id, r]));

  // Try to predict the next pick. Skip if the account has no creator_uuid
  // (the picker requires it to query content_inventory_onlyfans).
  let nextPick: {
    assetId: string;
    title: string;
    description: string | null;
    scriptNumber: number;
    rung: number;
    priceCents: number;
    previewMediaRef: string | null;
    reason: string;
  } | null = null;
  let nextPickError: string | null = null;
  if (account?.creatorUuid) {
    try {
      const archetype = await loadLatestArchetype(conv.subscriber_id);
      const picked = await pickNextForFan({
        accountId: conv.account_id,
        creatorUuid: account.creatorUuid,
        fanUuid: conv.subscriber_external_id,
        archetype,
        phase: conv.phase,
        requestedTopic: null,
      });
      if (picked) {
        nextPick = {
          assetId: picked.asset.id,
          title: picked.asset.title,
          description: picked.asset.description,
          scriptNumber: picked.scriptNumber,
          rung: picked.rung,
          priceCents: picked.priceCents,
          previewMediaRef: picked.previewMediaRef,
          reason: picked.reason,
        };
      }
    } catch (err) {
      nextPickError = err instanceof Error ? err.message : String(err);
    }
  } else {
    nextPickError = "account missing creator_uuid";
  }

  // Funnel state for the next-pick asset.
  const funnelStep = nextPick ? await getFunnelStep(conversationId, nextPick.assetId) : null;

  // Phase-based pitch eligibility (mirrors orchestrator MIN_TURNS_BETWEEN_PITCHES).
  const phasePitches = !["WARMUP", "RAPPORT", "SEXTING", "REACTIVATION", "COLD"].includes(conv.phase);

  // Decide a single human-readable label answering "what is the bot about
  // to do, ppv-wise?" — the most useful one-line summary.
  const dripIntervalTurns = 10;
  let label: string;
  let willPitchSoon: boolean;
  let turnsUntilNextPitch: number | null = null;
  if (!phasePitches) {
    label = `phase ${conv.phase} doesn't pitch — building rapport / heat first`;
    willPitchSoon = false;
  } else if (!nextPick) {
    label = nextPickError
      ? `picker cannot return next asset (${nextPickError})`
      : "picker found no eligible asset (catalog empty or all consumed)";
    willPitchSoon = false;
  } else if (funnelStep === "preview_sent") {
    label = `preview already sent for ${nextPick.title} — next turn fires the priced PPV`;
    willPitchSoon = true;
    turnsUntilNextPitch = 1;
  } else if (funnelStep === "ppv_sent") {
    label = `priced PPV already sent for ${nextPick.title} — awaiting unlock or drip re-pitch`;
    willPitchSoon = false;
  } else if (unbought >= unboughtThreshold) {
    const remaining = Math.max(0, dripIntervalTurns - turnsSinceLast);
    if (remaining === 0) {
      label = `drip pitch ready (${unbought} unbought, ${turnsSinceLast} turns since last) — next pitch fires WITH "support me" framing`;
      willPitchSoon = true;
      turnsUntilNextPitch = 0;
    } else {
      label = `drip pitch in ~${remaining} turns (${turnsSinceLast}/${dripIntervalTurns} since last pitch, ${unbought} unbought)`;
      willPitchSoon = false;
      turnsUntilNextPitch = remaining;
    }
  } else {
    label = `next asset ready: ${nextPick.title} (Script ${nextPick.scriptNumber} · rung ${nextPick.rung}). Will fire when AI readiness analyzer says go.`;
    willPitchSoon = true;
    turnsUntilNextPitch = 0;
  }

  // Purchase history.
  let purchases: Array<{
    scriptNumber: number | null;
    rung: number | null;
    amountCents: number | null;
    purchasedAt: Date;
  }> = [];
  if (account?.creatorUuid) {
    const rows = await listPurchasesByFan(conv.subscriber_external_id, account.creatorUuid);
    purchases = rows.map((p) => ({
      scriptNumber: p.scriptNumber,
      rung: p.rung,
      amountCents: p.amountCents,
      purchasedAt: p.purchasedAt,
    }));
  }

  return {
    found: true,
    conversationId: conv.conversation_id,
    subscriberExternalId: conv.subscriber_external_id,
    displayName: conv.display_name,
    phase: conv.phase,
    turnsInPhase: conv.turns_in_phase,
    lastActivityAt: conv.last_activity_at,
    pitchState: {
      label,
      willPitchSoon,
      turnsUntilNextPitch,
      phasePitches,
      turnsSinceLastPitch: Number.isFinite(turnsSinceLast) ? turnsSinceLast : null,
      unboughtRecent: unbought,
      dripActive: unbought >= unboughtThreshold,
      dripIntervalTurns,
      funnelStep,
      nextPick,
      nextPickError,
    },
    recentAttempts: recentAttempts.map((a) => {
      const cat = catalogById.get(a.assetId);
      const parsed = parseLegacySourceRef(cat?.source_ref ?? null);
      return {
        attemptId: a.id,
        assetId: a.assetId,
        title: cat?.title ?? null,
        scriptNumber: parsed?.scriptNumber ?? null,
        rung: parsed?.rung ?? null,
        priceCents: a.priceCents,
        outcome: a.outcome,
        pitchedAt: a.pitchedAt,
        unlockedAt: a.unlockedAt,
      };
    }),
    purchases,
  };
}

async function loadLastTurnAudit(conversationId: string): Promise<unknown> {
  const filter = JSON.stringify({ meta: { conversationId } });
  const row = await db
    .selectFrom("v3.llm_calls")
    .select(["id", "task", "provider", "model", "request", "response", "created_at"])
    .where("task", "=", "CHAT_GENERATE")
    .where(sql<SqlBool>`request @> ${filter}::jsonb`)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return { found: false };
  return {
    found: true,
    llmCallId: row.id,
    task: row.task,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    request: row.request,
    response: row.response,
  };
}

/**
 * Read the request body as raw UTF-8 text. Needed for HMAC signature
 * verification on webhook deliveries — we must hash the exact bytes the
 * sender signed, so we can't JSON-parse first.
 */
async function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 5_000_000) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 1_000_000) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
}

/**
 * Pull the originating client IP. Cloudflare Tunnel + standard reverse proxies
 * set `cf-connecting-ip` or `x-forwarded-for`; fall back to the socket address.
 * For `x-forwarded-for` (which can be a comma-separated chain), use the LEFT-
 * most entry — that's the original client per RFC 7239.
 */
function clientIp(req: http.IncomingMessage): string | null {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? null;
}

/**
 * Trust check for the unsigned webhook endpoint.
 *
 * If `PLATFORM_WEBHOOK_TRUSTED_IPS` is unset, fall through (dev / shadow-mode
 * behaviour). When set, expect a comma-separated list of IPs / CIDRs — any
 * exact match passes. CIDR support is intentionally minimal: only `IP/64`
 * and `IP/32` style prefix matches, since we just need to whitelist OFAPI's
 * known egress (a couple of IPs).
 */
/**
 * Parse PLATFORM_ACCOUNT_ALLOWLIST into a Set for O(1) lookup. Memoised at
 * module scope so we don't re-split per request. Returns null when no
 * allowlist is configured (i.e. accept any account — only safe in dev).
 */
let _allowlistCache: Set<string> | null | undefined;
function parseAllowlist(): Set<string> | null {
  if (_allowlistCache !== undefined) return _allowlistCache;
  const raw = env.PLATFORM_ACCOUNT_ALLOWLIST;
  if (!raw) {
    _allowlistCache = null;
    return null;
  }
  _allowlistCache = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return _allowlistCache;
}

function trustedSource(sourceIp: string | null): boolean {
  const list = env.PLATFORM_WEBHOOK_TRUSTED_IPS;
  if (!list) return true; // open by default — secret + signature is the alternate gate
  if (!sourceIp) return false;
  for (const entry of list.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (entry === sourceIp) return true;
    // IPv6 prefix match (e.g. "2a01:4ff:f0:46fb::/64" trusts a whole subnet).
    const slashIdx = entry.indexOf("/");
    if (slashIdx > 0) {
      const prefix = entry.slice(0, slashIdx);
      // Naive prefix-string match — fine for whitelisting one or two known
      // egress subnets; not a substitute for a real CIDR library if you need
      // production-grade matching.
      if (sourceIp.startsWith(prefix.split("::")[0] ?? prefix)) return true;
    }
  }
  return false;
}
