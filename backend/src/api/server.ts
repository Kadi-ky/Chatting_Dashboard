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
import { loadAccountByPlatformId, upsertShadowAccount } from "../db/repos/accounts.js";

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
      logger.error({ err: err instanceof Error ? err.message : err }, "webhook parseWebhook threw");
      return json(res, 200, { received: 0, error: "parse_failed" });
    }
    if (events === null) {
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

    if (method === "GET" && path === "/admin/threads") {
      return json(res, 200, await loadThreads());
    }

    const threadDetailMatch = /^\/admin\/threads\/([^/]+)$/.exec(path);
    if (method === "GET" && threadDetailMatch) {
      const [, convId] = threadDetailMatch;
      return json(res, 200, await loadThread(convId as string));
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
    const cfg = (r.account_config ?? {}) as Record<string, unknown>;
    const isShadow = cfg.shadow === true;
    const isTest = r.account_id === TEST_ACCOUNT_ID;
    // "production" requires a real platform_account_id AND not shadow flag.
    // Anything missing platform_account_id is a manual /admin/test/inject and
    // gets bucketed as "test" so it doesn't pollute the production lane.
    const hasPlatformId = Boolean(r.platform_account_id);
    const source: "test" | "shadow" | "production" = isShadow
      ? "shadow"
      : isTest || !hasPlatformId
        ? "test"
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
