import crypto from "node:crypto";
import type {
  AccountContext,
  AdapterCapabilities,
  BroadcastRequest,
  BroadcastResult,
  FanList,
  FetchMissedResult,
  IncomingWebhook,
  PlatformAdapter,
  PlatformEvent,
  SendFreeMediaRequest,
  SendMessageRequest,
  SendPPVRequest,
  SendResult,
  SubscriberSnapshot,
} from "../../PlatformAdapter.js";
import { PlatformHttpClient, PlatformHttpError } from "./client.js";
import { markFanUnreachable } from "./unreachable.js";
import { env } from "../../../config/index.js";
import { logger } from "../../../observability/logger.js";

/**
 * HTTP adapter over the platform's REST API.
 *
 * URL shape targets OnlyFansAPI: `/api/{account_id}/...`. The adapter itself
 * holds one bearer token (team-wide) and routes each call to the creator's
 * account by prefixing the upstream platform's account id.
 *
 * Endpoint paths are close to the OpenAPI spec at repo root but may need
 * small adjustments once we wire real traffic. Shape matters more than path
 * — the rest of the pipeline is stable.
 */
export class HttpPlatformAdapter implements PlatformAdapter {
  constructor(private readonly http: PlatformHttpClient = new PlatformHttpClient()) {}

  capabilities(): AdapterCapabilities {
    return {
      hasWebhooks: true,
      hasMassMessage: true,
      hasLists: true,
      hasReadReceipts: true,
      hasPPV: true,
    };
  }

  // ─── inbound (polling fallback) ───────────────────────────────────────
  async fetchMissedSince(ctx: AccountContext, cursor: string | null): Promise<FetchMissedResult> {
    const resp = await this.http.request<PlatformInboxResponse>(
      `/api/${ctx.platformAccountId}/inbox/events`,
      { query: { cursor: cursor ?? undefined, limit: 100 } },
    );
    const events = resp.items
      .map((i) => normalizeEvent(i, ctx.platformAccountId))
      .filter((e): e is PlatformEvent => e !== null);
    return { events, nextCursor: resp.next_cursor, hasMore: resp.has_more };
  }

  // ─── inbound (webhook) ────────────────────────────────────────────────
  parseWebhook(delivery: IncomingWebhook): PlatformEvent[] | null {
    const secret = env.PLATFORM_WEBHOOK_SECRET;
    if (secret) {
      const sigHeader =
        headerOne(delivery.headers, "x-signature") ??
        headerOne(delivery.headers, "x-ofapi-signature") ??
        headerOne(delivery.headers, "x-hub-signature-256");
      if (!sigHeader || !verifyHmacSignature(secret, delivery.rawBody, sigHeader)) {
        logger.warn({ hasSig: Boolean(sigHeader) }, "webhook signature invalid");
        return null;
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(delivery.rawBody);
    } catch {
      logger.warn("webhook body not json");
      return null;
    }

    // Per-delivery idempotency key from the OFAPI header. Used as the inbound
    // queue jobId so retries / duplicate webhooks don't double-process.
    const deliveryIdempotency = headerOne(delivery.headers, "x-ofapi-idempotency-key");

    // OnlyFansAPI real-world shape (verified against 4 real production webhook
    // samples — messages.received / messages.ppv.unlocked / subscriptions.new):
    //
    //   { event: "<dotted.name>", account_id: "acct_xxx", payload: {...} }
    //
    // The webhook is single-event per delivery, but n8n forwarding sometimes
    // wraps in an array ([{headers, body, ...}]) — we tolerate both. Older
    // batched / `type`+`data` shapes are kept as fallbacks so the mock adapter
    // tests continue to pass.
    const items: PlatformInboxItem[] = [];
    if (Array.isArray(parsed)) {
      for (const wrapped of parsed) {
        if (wrapped && typeof wrapped === "object") {
          const w = wrapped as Record<string, unknown>;
          // n8n-style: { body: { event, account_id, payload }, headers: {...} }
          // The wrapped headers carry their own idempotency key — prefer that
          // over the outer (n8n-injected) headers when present.
          const wrappedHeaders = (w.headers && typeof w.headers === "object"
            ? (w.headers as Record<string, string>)
            : {});
          const wrappedIdemp = headerOne(wrappedHeaders, "x-ofapi-idempotency-key");
          const inner = w.body && typeof w.body === "object" ? (w.body as PlatformInboxItem) : (w as PlatformInboxItem);
          if (wrappedIdemp || deliveryIdempotency) {
            inner.idempotency_key = wrappedIdemp ?? deliveryIdempotency!;
          }
          items.push(inner);
        }
      }
    } else if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      const candidate: PlatformInboxItem | null = (() => {
        if (p.event && p.account_id) return p as PlatformInboxItem;
        if (Array.isArray((p as { data?: unknown[] }).data)) {
          // Push each separately below.
          return null;
        }
        if (Array.isArray(p.events)) return null;
        if (p.type || p.event) return p as PlatformInboxItem;
        return null;
      })();
      if (candidate) {
        if (deliveryIdempotency) candidate.idempotency_key = deliveryIdempotency;
        items.push(candidate);
      } else if (Array.isArray((p as { data?: unknown[] }).data)) {
        items.push(...(p.data as PlatformInboxItem[]));
      } else if (Array.isArray(p.events)) {
        items.push(...(p.events as PlatformInboxItem[]));
      }
    }

    const events: PlatformEvent[] = [];
    for (const item of items) {
      const platformAccountId = extractAccountId(item);
      if (!platformAccountId) {
        logger.warn({ item: { event: item.event, type: item.type } }, "webhook missing account_id");
        continue;
      }
      const normalised = normalizeEvent(item, platformAccountId);
      if (normalised) events.push(normalised);
    }
    return events;
  }

  // ─── outbound ─────────────────────────────────────────────────────────
  async sendMessage(ctx: AccountContext, req: SendMessageRequest): Promise<SendResult> {
    if (env.SHADOW_MODE) return shadowSend("message", ctx, req);
    if (!isRealOfapiAccount(ctx.platformAccountId)) {
      // Synthetic test fan (loop-* / longtime-* / *-probe-* paired with
      // mock account id). Stop hitting real OFAPI with /api/mock/... 404s
      // (which were inflating the "outbound failure rate" metric).
      // Returns a shadow result so the rest of the pipeline still records
      // the message correctly.
      return shadowSend("message", ctx, req);
    }
    // OnlyFansAPI returns { data: { id, createdAt, ... }, _meta: {...} }.
    // id comes back as a NUMBER (not string), so we coerce. createdAt is the
    // server timestamp; there is no separate `sent_at` field.
    try {
      const resp = await this.http.request<OFAPIResponse<OFAPISentMessage>>(
        `/api/${ctx.platformAccountId}/chats/${req.subscriberExternalId}/messages`,
        {
          method: "POST",
          idempotencyKey: req.idempotencyKey,
          body: { text: req.text },
        },
      );
      return { externalId: String(resp.data.id), sentAt: new Date(resp.data.createdAt) };
    } catch (err) {
      // OFAPI 400 "Cannot send message to this user" — fan blocked us /
      // unsubscribed / disabled DMs / account suspended. Flag in Redis so
      // outreach + nudge workers skip future attempts. Operator audit
      // 2026-05-11: ~10% of cold outreach was burning sends on these
      // dead fans before we filtered. Re-throw so the rest of the
      // pipeline still records the failure normally.
      if (err instanceof PlatformHttpError && err.status === 400 && err.body.includes("Cannot send message to this user")) {
        await markFanUnreachable(ctx.platformAccountId, req.subscriberExternalId).catch(() => undefined);
      }
      throw err;
    }
  }

  async sendPPV(ctx: AccountContext, req: SendPPVRequest): Promise<SendResult> {
    if (env.SHADOW_MODE) return shadowSend("ppv", ctx, req);
    if (!isRealOfapiAccount(ctx.platformAccountId)) {
      return shadowSend("ppv", ctx, req);
    }
    // OnlyFansAPI quirks (verified against real n8n outbound + response samples):
    //   - field is `mediaFiles` (camelCase, NOT `media_ids`)
    //   - field is `price` in DOLLARS as a number (NOT `price_cents` in cents)
    //   - no `is_ppv` flag — its presence is implied by `price > 0` + media
    const resp = await this.http.request<OFAPIResponse<OFAPISentMessage>>(
      `/api/${ctx.platformAccountId}/chats/${req.subscriberExternalId}/messages`,
      {
        method: "POST",
        idempotencyKey: req.idempotencyKey,
        body: {
          text: req.caption ?? "",
          price: centsToDollars(req.priceCents),
          mediaFiles: [req.assetRef],
        },
      },
    );
    return { externalId: String(resp.data.id), sentAt: new Date(resp.data.createdAt) };
  }

  async sendFreeMedia(ctx: AccountContext, req: SendFreeMediaRequest): Promise<SendResult> {
    if (env.SHADOW_MODE) return shadowSend("free_media", ctx, req);
    if (!isRealOfapiAccount(ctx.platformAccountId)) {
      return shadowSend("free_media", ctx, req);
    }
    // Free preview send. CRITICAL: omit the `price` field entirely — sending
    // `price: 0` makes OFAPI treat the message as a malformed PPV and reject
    // it (or render it as a $0 paywalled bubble, which looks broken). The
    // n8n flow proves omitting price + including text + mediaFiles posts as
    // a normal in-DM photo/clip the fan sees inline.
    const resp = await this.http.request<OFAPIResponse<OFAPISentMessage>>(
      `/api/${ctx.platformAccountId}/chats/${req.subscriberExternalId}/messages`,
      {
        method: "POST",
        idempotencyKey: req.idempotencyKey,
        body: {
          text: req.caption,
          mediaFiles: [req.mediaRef],
        },
      },
    );
    return { externalId: String(resp.data.id), sentAt: new Date(resp.data.createdAt) };
  }

  async deleteMessage(
    ctx: AccountContext,
    args: { chatId: string; messageExternalId: string },
  ): Promise<void> {
    if (env.SHADOW_MODE) {
      logger.debug(
        { shadow: true, chatId: args.chatId, messageExternalId: args.messageExternalId },
        "SHADOW_MODE: would-delete message",
      );
      return;
    }
    if (!isRealOfapiAccount(ctx.platformAccountId)) {
      logger.debug(
        { platformAccountId: ctx.platformAccountId },
        "deleteMessage skipped — non-OFAPI account (mock / unprovisioned)",
      );
      return;
    }
    // OFAPI: DELETE /api/{account}/chats/{chat_id}/messages/{message_id}
    // Costs 1 credit, only works on messages <24h old. Older deletes return
    // an error — we swallow because the DB row is already marked expired
    // and downstream logic doesn't depend on the platform-side delete
    // succeeding. Fan might still SEE the old bubble in their app, but
    // any unlock against it routes to the new attempt anyway.
    try {
      await this.http.request(
        `/api/${ctx.platformAccountId}/chats/${args.chatId}/messages/${args.messageExternalId}`,
        { method: "DELETE" },
      );
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : err,
          chatId: args.chatId,
          messageExternalId: args.messageExternalId,
        },
        "deleteMessage failed (non-fatal — DB already marked expired)",
      );
    }
  }

  async sendTypingIndicator(ctx: AccountContext, subscriberExternalId: string): Promise<void> {
    if (env.SHADOW_MODE) {
      logger.debug({ shadow: true, subscriberExternalId }, "SHADOW_MODE: would-fire typing indicator");
      return;
    }
    if (!isRealOfapiAccount(ctx.platformAccountId)) {
      logger.debug(
        { platformAccountId: ctx.platformAccountId },
        "typing indicator skipped — non-OFAPI account (mock / unprovisioned)",
      );
      return;
    }
    // OFAPI: POST /api/{account}/chats/{chat_id}/typing — shows "Model is
    // typing..." for ~4s. Free (no credits), no body, no idempotency.
    // Fan UX win: covers the API call latency so messages don't appear out
    // of nowhere. NEVER throw — typing failure must not fail the send.
    try {
      await this.http.request(
        `/api/${ctx.platformAccountId}/chats/${subscriberExternalId}/typing`,
        { method: "POST" },
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, subscriberExternalId },
        "typing indicator failed (non-fatal)",
      );
    }
  }

  async markRead(ctx: AccountContext, conversationExternalId: string): Promise<void> {
    await this.http.request(`/api/${ctx.platformAccountId}/chats/${conversationExternalId}/read`, {
      method: "POST",
    });
  }

  // ─── lifecycle ────────────────────────────────────────────────────────
  // OFAPI: GET /api/{account}/fans/all — offset-based pagination, limit
  // capped at 20 per page (NOT 100 like our prior cursor-based assumption).
  // Response shape: { data: [...fan...], _meta: {...} } — `data` may be
  // a flat array OR { fans: [...], total }. Defensive parser handles
  // both. The `cursor` arg is ignored (kept for the interface);
  // paginates internally until OFAPI returns an empty page.
  async *listSubscribers(ctx: AccountContext, _cursor?: string): AsyncIterable<SubscriberSnapshot> {
    const PAGE_LIMIT = 20;
    let offset = 0;
    let firstPageLogged = false;
    // Per-page 429 retry. OFAPI's CF 1015 lockouts return retry_after=30 in
    // the response BODY but a "0" in the Retry-After header (so the http
    // client's retryAfterMs is 0 and useless). Fall back to a fixed
    // exponential schedule: 30s, 60s, 120s. After 3 retries on the same
    // page give up and let the iterator end. Operator paused subsync
    // 2026-04-30 because of these; this re-enables safely.
    const RATE_LIMIT_BACKOFFS_MS = [30_000, 60_000, 120_000];
    const fetchPageWithRetry = async (): Promise<unknown> => {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFFS_MS.length; attempt++) {
        try {
          return await this.http.request<unknown>(
            `/api/${ctx.platformAccountId}/fans/all`,
            { query: { limit: PAGE_LIMIT, offset, type: "active" } },
          );
        } catch (err) {
          lastErr = err;
          const isPlatformErr = err instanceof PlatformHttpError;
          const isRateLimit = isPlatformErr && err.status === 429;
          if (!isRateLimit || attempt === RATE_LIMIT_BACKOFFS_MS.length) throw err;
          const waitMs = err.retryAfterMs && err.retryAfterMs > 0
            ? err.retryAfterMs
            : RATE_LIMIT_BACKOFFS_MS[attempt]!;
          logger.warn(
            { offset, attempt, waitMs, status: err.status },
            "subsync 429 — sleeping then retrying",
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      throw lastErr ?? new Error("listSubscribers retry loop exhausted");
    };
    while (true) {
      const resp = await fetchPageWithRetry();
      // Log the first page's raw response shape so we can adjust the
      // parser if OFAPI returns something we didn't anticipate. Logged
      // once per sync run; structured (top-level keys + sample row).
      if (!firstPageLogged) {
        firstPageLogged = true;
        const sampleKeys =
          typeof resp === "object" && resp !== null
            ? Object.keys(resp as Record<string, unknown>).slice(0, 10)
            : [];
        const sampleFan = extractFanList(resp)[0] ?? null;
        const sampleFanKeys =
          typeof sampleFan === "object" && sampleFan !== null
            ? Object.keys(sampleFan as Record<string, unknown>).slice(0, 15)
            : [];
        logger.info(
          {
            platformAccountId: ctx.platformAccountId,
            topLevelKeys: sampleKeys,
            extractedListLength: extractFanList(resp).length,
            firstFanKeys: sampleFanKeys,
            firstFanPreview:
              typeof sampleFan === "object" && sampleFan !== null
                ? JSON.stringify(sampleFan).slice(0, 300)
                : null,
            isArray: Array.isArray(resp),
          },
          "subsync first-page response shape",
        );
      }
      const fans = extractFanList(resp);
      if (fans.length === 0) break;
      for (const f of fans) {
        const snap = normalizeOfapiFan(f);
        if (snap) yield snap;
      }
      // OFAPI returns partial pages (e.g., 19 instead of 20) even when
      // more data remains — confirmed via /admin/debug/ofapi-fans at
      // offsets 40 and 60 both returning 19. Don't break on partial; only
      // break on empty. The 50_000 offset cap below guards against an
      // infinite loop if OFAPI ever stops returning empty at the tail.
      offset += PAGE_LIMIT;
      if (offset >= 50_000) break;
    }
  }

  async listLists(ctx: AccountContext): Promise<FanList[]> {
    const resp = await this.http.request<{ items: PlatformList[] }>(
      `/api/${ctx.platformAccountId}/user-lists`,
    );
    return resp.items.map((l) => ({
      externalId: l.id,
      name: l.name,
      memberCount: l.member_count,
    }));
  }

  async broadcastToList(ctx: AccountContext, req: BroadcastRequest): Promise<BroadcastResult> {
    const resp = await this.http.request<{
      id: string;
      scheduled_for?: string;
      recipient_count: number;
    }>(`/api/${ctx.platformAccountId}/mass-messages`, {
      method: "POST",
      idempotencyKey: req.idempotencyKey,
      body: {
        list_id: req.listExternalId,
        text: req.text,
        media_ids: req.assetRef ? [req.assetRef] : undefined,
        price_cents: req.priceCents,
      },
    });
    return {
      externalId: resp.id,
      recipientCount: resp.recipient_count,
      ...(resp.scheduled_for ? { scheduledFor: new Date(resp.scheduled_for) } : {}),
    };
  }
}

// ─── account-id guard ─────────────────────────────────────────────────────

/**
 * Returns true if the platform account id looks like a real OFAPI id
 * (acct_xxxxx). Synthetic test conversations sometimes have "mock" or other
 * placeholders here; firing real OFAPI calls against those returns 404 with
 * "You must use the OFAPI ID (starting with acct_)" — pure log noise. Adapter
 * methods that aren't on the critical send path (typing indicator, delete)
 * skip outright when this returns false.
 *
 * The actual sendMessage / sendPPV / sendFreeMedia paths still attempt the
 * call so genuine misconfigurations get flagged loudly via the existing
 * outbound failure handling — better to see "send failed" than to silently
 * drop messages.
 */
function isRealOfapiAccount(platformAccountId: string): boolean {
  return typeof platformAccountId === "string" && platformAccountId.startsWith("acct_");
}

// ─── shadow mode + send-response helpers ─────────────────────────────────

/**
 * SHADOW_MODE bypass: log the would-send payload, return a synthetic
 * SendResult that downstream sendWorker treats as success. The synthetic
 * externalId is prefixed `shadow:` so the dashboard / DB queries can tell
 * the difference between a real platform delivery and a shadow ghost.
 */
function shadowSend(
  kind: "message" | "ppv" | "free_media",
  ctx: AccountContext,
  req: SendMessageRequest | SendPPVRequest | SendFreeMediaRequest,
): SendResult {
  logger.info(
    {
      shadow: true,
      kind,
      accountId: ctx.accountId,
      platformAccountId: ctx.platformAccountId,
      subscriberExternalId: req.subscriberExternalId,
      idempotencyKey: req.idempotencyKey,
      ...(kind === "message"
        ? { text: (req as SendMessageRequest).text }
        : kind === "ppv"
          ? {
              caption: (req as SendPPVRequest).caption,
              assetRef: (req as SendPPVRequest).assetRef,
              priceCents: (req as SendPPVRequest).priceCents,
            }
          : {
              caption: (req as SendFreeMediaRequest).caption,
              mediaRef: (req as SendFreeMediaRequest).mediaRef,
            }),
    },
    "SHADOW_MODE: would-send (no platform call)",
  );
  return {
    externalId: `shadow:${kind}:${req.idempotencyKey}`,
    sentAt: new Date(),
  };
}

/** OnlyFansAPI envelope: every response is { data: ..., _meta: {...} }. */
interface OFAPIResponse<T> {
  data: T;
  _meta?: {
    _credits?: { used: number; balance: number; note?: string };
    _rate_limits?: {
      limit_minute: number | null;
      limit_day: number | null;
      remaining_minute: number | null;
      remaining_day: number | null;
    };
  };
}

interface OFAPISentMessage {
  id: number; // numeric — caller stringifies for storage
  createdAt: string; // ISO timestamp
  text?: string;
  price?: number; // dollars
  mediaCount?: number;
  isFree?: boolean;
}

/**
 * OnlyFansAPI's `price` field is dollars-as-a-number (e.g. 15 for $15.00,
 * 9.99 for $9.99). Convert from our internal cents-as-int.
 */
function centsToDollars(cents: number): number {
  if (cents <= 0) return 0;
  // Two-decimal precision; OF supports $9.99-style prices.
  return Math.round(cents) / 100;
}

// ─── wire shapes (rename fields to match actual platform OpenAPI) ────────
interface PlatformInboxResponse {
  items: PlatformInboxItem[];
  next_cursor: string;
  has_more: boolean;
}

interface PlatformInboxItem {
  id?: string | number;
  type?: string;
  event?: string;
  account_id?: string;
  conversation_id?: string;
  sender_id?: string;
  from_user?: { id?: string };
  occurred_at?: string;
  created_at?: string;
  text?: string;
  attachments?: Array<{ kind: string; ref: string }>;
  data?: Record<string, unknown>;
  /** Real OFAPI: nested event payload (the `payload` key in webhook bodies). */
  payload?: Record<string, unknown>;
  /** Real OFAPI: per-delivery idempotency key from `x-ofapi-idempotency-key` header. Caller copies it onto the item before parse. */
  idempotency_key?: string;
  [k: string]: unknown;
}

interface PlatformSubscribersResponse {
  items: PlatformSubscriberItem[];
  next_cursor: string;
  has_more: boolean;
}

interface PlatformSubscriberItem {
  id: string;
  display_name?: string;
  subscribed_at?: string;
  expires_at?: string;
  is_active: boolean;
  [k: string]: unknown;
}

interface PlatformList {
  id: string;
  name: string;
  member_count: number;
}

function normalizeEvent(item: PlatformInboxItem, platformAccountId: string): PlatformEvent | null {
  const rawKind = item.event ?? item.type;
  if (!rawKind) return null;
  const kind = mapEventKind(rawKind);
  if (!kind) return null;

  // Real OFAPI shape nests everything under `payload`. Older / mock shapes
  // don't, so look in both places.
  const payload = (typeof item.payload === "object" && item.payload !== null
    ? (item.payload as Record<string, unknown>)
    : (item as unknown as Record<string, unknown>));

  // Fan id lookup — the location varies by event type:
  //   messages.received  → payload.fromUser.id  (number)
  //   ppv.unlocked       → payload.user.id      (number — NOT payload.user_id which seems to be the creator)
  //   subscriptions.new  → payload.user.id      (number)
  //   tips.received      → payload.user.id      (assumed parallel)
  // Mock / older shapes still set sender_id / from_user.id flat on the item.
  const subscriberExternalId = extractFanId(payload, item);
  if (!subscriberExternalId) {
    logger.warn({ kind, rawKind }, "webhook missing fan id");
    return null;
  }

  // Idempotency: prefer the wrapper-level idempotency key (per-delivery, set
  // by OFAPI), falling back to the inner payload id (per-message). Both work,
  // but the wrapper key is what `x-ofapi-idempotency-key` carries.
  const externalId = String(
    item.idempotency_key ??
    payload.id ??
    item.id ??
    `${rawKind}-${Date.now()}`,
  );

  const occurredAt = String(
    payload.createdAt ??
    item.occurred_at ??
    item.created_at ??
    new Date().toISOString(),
  );

  // Build kind-specific normalized payload. We keep the FULL raw payload
  // alongside extracted fields so downstream handlers can dig deeper if
  // needed (e.g. to read fanData.spending for archetype init).
  const normalizedPayload: Record<string, unknown> = { ...payload, raw: payload };

  if (kind === "message.received") {
    normalizedPayload.text = stripHtml(String(payload.text ?? ""));
    if (Array.isArray(payload.media)) {
      normalizedPayload.attachments = (payload.media as Array<Record<string, unknown>>).map((m) => ({
        kind: String(m.type ?? "media"),
        ref: String(m.id ?? ""),
      }));
    }
  } else if (kind === "ppv.unlocked") {
    // Price comes from `replacePairs.{AMOUNT}` like "$10.00" — no native cents
    // field. Parse to integer cents for the orchestrator's price-keyed logic.
    const amountCents = parsePriceToCents(payload);
    if (amountCents != null) normalizedPayload.price_cents = amountCents;
    // Asset ref: linked message id is buried in the text URL as `?firstId=...`.
    // Surfacing it lets handlePpvUnlocked link the unlock back to the EXACT
    // pending attempt (not just the most recent one).
    const linkedMessageId = extractFirstIdFromText(String(payload.text ?? ""));
    if (linkedMessageId) normalizedPayload.asset_ref = linkedMessageId;
  } else if (kind === "tip.received") {
    const amountCents = parsePriceToCents(payload);
    if (amountCents != null) normalizedPayload.amount_cents = amountCents;
  } else if (kind === "subscription.started" || kind === "subscription.expired") {
    // expires_at not provided on `subscriptions.new` event — handler will
    // derive from subscriber.subscribedByExpireDate if present, or leave null.
    if (payload.user && typeof payload.user === "object") {
      const u = payload.user as Record<string, unknown>;
      if (typeof u.name === "string") normalizedPayload.display_name = u.name;
    }
  }

  // Conversation id: use the fan id as the conv key (OFAPI doesn't have a
  // separate conversation id — chats are 1:1 keyed by fan).
  return {
    externalId,
    kind,
    platformAccountId,
    subscriberExternalId,
    payload: normalizedPayload,
    occurredAt: new Date(occurredAt),
    conversationExternalId: subscriberExternalId,
  };
}

/** Extract fan id from real OFAPI payload variants + legacy fallbacks. */
function extractFanId(payload: Record<string, unknown>, item: PlatformInboxItem): string | null {
  // messages.received nests fan under `fromUser`
  if (payload.fromUser && typeof payload.fromUser === "object") {
    const fu = payload.fromUser as Record<string, unknown>;
    if (fu.id != null) return String(fu.id);
  }
  // ppv.unlocked / subscriptions.new / tips.received nest fan under `user`
  if (payload.user && typeof payload.user === "object") {
    const u = payload.user as Record<string, unknown>;
    if (u.id != null) return String(u.id);
  }
  // Legacy / mock fallbacks
  if (item.sender_id) return String(item.sender_id);
  if (item.from_user?.id != null) return String(item.from_user.id);
  if (typeof payload.user_id === "string" || typeof payload.user_id === "number") {
    return String(payload.user_id);
  }
  return null;
}

/**
 * OnlyFansAPI doesn't expose `price_cents` on unlock / tip events. The amount
 * comes back as `replacePairs.{AMOUNT}` like "$10.00" or "$5.50". Parse to
 * integer cents (1000 / 550). Returns null on parse failure.
 */
function parsePriceToCents(payload: Record<string, unknown>): number | null {
  // First check for an explicit price field (some events do include it).
  if (typeof payload.price === "number") {
    return Math.round(payload.price * 100);
  }
  // Then dig into replacePairs for $X.XX pattern.
  const rp = payload.replacePairs as Record<string, unknown> | undefined;
  const amount = rp?.["{AMOUNT}"];
  if (typeof amount === "string") {
    const m = /\$?\s*([\d,]+(?:\.\d+)?)/.exec(amount);
    if (m && m[1]) {
      const dollars = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(dollars)) return Math.round(dollars * 100);
    }
  }
  return null;
}

/**
 * Pull the linked message id from the OF-formatted text URL.
 * Example text: "...purchased your <a href='https://onlyfans.com/my/chats/chat/371729709?firstId=9410988514181'>message</a>..."
 * Returns "9410988514181" → caller uses it to find the right pending PPV attempt.
 */
function extractFirstIdFromText(text: string): string | null {
  const m = /[?&]firstId=(\d+)/.exec(text);
  return m ? (m[1] ?? null) : null;
}

/** Strip OF's `<p>...</p>` and similar HTML wrapping from message text. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function mapEventKind(type: string): PlatformEvent["kind"] | null {
  switch (type) {
    // Inbound messages from fans
    case "message":
    case "messages.received":
    case "message.received":
      return "message.received";

    // Subscription lifecycle. OnlyFansAPI splits "new" and "renewed" — both
    // collapse to subscription.started for our purposes (creates / refreshes
    // the subscriber row, resets the cold counter, doesn't trigger a pitch).
    case "subscription.started":
    case "subscriptions.new":
    case "subscriptions.renewed":
    case "subscribed":
      return "subscription.started";

    // OFAPI does NOT fire an "expired" event; this is here for the mock /
    // future-proofing only. Expiry detection in prod is via expires_at polling.
    case "subscription.expired":
    case "subscriptions.expired":
    case "unsubscribed":
      return "subscription.expired";

    case "ppv.unlocked":
    case "messages.ppv.unlocked":
    case "unlock":
      return "ppv.unlocked";

    case "tip":
    case "tip.received":
    case "tips.received":
      return "tip.received";

    // Known events we deliberately ignore: `transactions.new` is a generic
    // catch-all that duplicates ppv.unlocked + tips.received → subscribing
    // would double-count revenue. The two `accounts.*` events are creator-
    // side admin alerts (their OF login broke), not fan interactions; they'd
    // be handled in a separate alerting pipeline if we built one.
    case "transactions.new":
    case "accounts.authentication_failed":
    case "accounts.session_expired":
      return null;

    default:
      return null;
  }
}

function normalizeSubscriber(s: PlatformSubscriberItem): SubscriberSnapshot {
  return {
    externalId: s.id,
    ...(s.display_name !== undefined ? { displayName: s.display_name } : {}),
    ...(s.subscribed_at !== undefined ? { subscribedAt: new Date(s.subscribed_at) } : {}),
    ...(s.expires_at !== undefined ? { expiresAt: new Date(s.expires_at) } : {}),
    isActive: s.is_active,
    metadata: s as Record<string, unknown>,
  };
}

/**
 * OFAPI's /fans/all response is wrapped in different shapes depending
 * on tier — sometimes { data: [...] }, sometimes { data: { fans: [...] } },
 * sometimes a bare array. This handles all three.
 */
function extractFanList(resp: unknown): unknown[] {
  if (Array.isArray(resp)) return resp;
  if (typeof resp !== "object" || resp === null) return [];
  const r = resp as Record<string, unknown>;
  if (Array.isArray(r.data)) return r.data;
  if (Array.isArray(r.fans)) return r.fans;
  if (Array.isArray(r.list)) return r.list;
  if (typeof r.data === "object" && r.data !== null) {
    const d = r.data as Record<string, unknown>;
    // OFAPI's actual shape (confirmed via /admin/debug/ofapi-fans 2026-04-30):
    //   { data: { list: [...fans...] }, _pagination, _meta }
    // Older d.fans / d.data branches kept for tier compatibility.
    if (Array.isArray(d.list)) return d.list;
    if (Array.isArray(d.fans)) return d.fans;
    if (Array.isArray(d.data)) return d.data;
  }
  return [];
}

/**
 * OFAPI fan shape uses camelCase + numeric ids, different from our
 * snake_case PlatformSubscriberItem normalization. Common fields seen
 * across OFAPI tiers:
 *   { id: <number>, name?: string, username?: string, isActive?: bool,
 *     subscribedBy?: ISO, subscribedByExpireDate?: ISO, ... }
 * Coerces id to string for our internal model. Returns null if no id.
 */
function normalizeOfapiFan(f: unknown): SubscriberSnapshot | null {
  if (typeof f !== "object" || f === null) return null;
  const r = f as Record<string, unknown>;
  const rawId = r.id ?? r.userId ?? r.user_id;
  if (rawId == null) return null;
  const externalId = String(rawId);
  // Display name: prefer `name`, then `username`, then null.
  let displayName: string | undefined;
  if (typeof r.name === "string" && r.name.trim().length > 0) displayName = r.name.trim();
  else if (typeof r.username === "string" && r.username.trim().length > 0) displayName = r.username.trim();
  // Subscription dates — OFAPI uses subscribedBy / subscribedByExpireDate.
  const subscribedAt =
    typeof r.subscribedBy === "string" ? new Date(r.subscribedBy)
    : typeof r.subscribed_at === "string" ? new Date(r.subscribed_at)
    : undefined;
  const expiresAt =
    typeof r.subscribedByExpireDate === "string" ? new Date(r.subscribedByExpireDate)
    : typeof r.expires_at === "string" ? new Date(r.expires_at)
    : undefined;
  const isActive =
    typeof r.isActive === "boolean" ? r.isActive
    : typeof r.is_active === "boolean" ? r.is_active
    : true; // default to active when filter=active is the query
  return {
    externalId,
    ...(displayName ? { displayName } : {}),
    ...(subscribedAt && !Number.isNaN(subscribedAt.getTime()) ? { subscribedAt } : {}),
    ...(expiresAt && !Number.isNaN(expiresAt.getTime()) ? { expiresAt } : {}),
    isActive,
    metadata: r,
  };
}

function extractAccountId(item: PlatformInboxItem): string | null {
  // Real OFAPI shape: account_id at the body root, alongside event + payload.
  if (typeof item.account_id === "string") return item.account_id;
  // Some shapes nest under data; older adapters used this.
  if (item.data && typeof item.data === "object") {
    const d = item.data as Record<string, unknown>;
    if (typeof d.account_id === "string") return d.account_id;
  }
  // Defensive: if account_id ended up inside payload (shouldn't happen on
  // OFAPI but seen on forwarded variants).
  if (item.payload && typeof item.payload === "object") {
    const p = item.payload as Record<string, unknown>;
    if (typeof p.account_id === "string") return p.account_id;
  }
  return null;
}

function headerOne(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const v = headers[name.toLowerCase()];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return null;
}

/**
 * HMAC-SHA256 signature check. Accepts either a raw hex digest or the
 * `sha256=<hex>` prefix common to GitHub-style webhooks. Uses timing-safe
 * comparison.
 */
function verifyHmacSignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}
