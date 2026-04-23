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
  SendMessageRequest,
  SendPPVRequest,
  SendResult,
  SubscriberSnapshot,
} from "../../PlatformAdapter.js";
import { PlatformHttpClient } from "./client.js";
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

    // OnlyFansAPI delivers one event per request with `type` + `data`;
    // tolerate both single-event and batched shapes.
    const items: PlatformInboxItem[] = [];
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      if (Array.isArray((p as { data?: unknown[] }).data)) {
        items.push(...(p.data as PlatformInboxItem[]));
      } else if (p.type || p.event) {
        items.push(p as PlatformInboxItem);
      } else if (Array.isArray(p.events)) {
        items.push(...(p.events as PlatformInboxItem[]));
      }
    }

    const events: PlatformEvent[] = [];
    for (const item of items) {
      const platformAccountId = extractAccountId(item);
      if (!platformAccountId) continue;
      const normalised = normalizeEvent(item, platformAccountId);
      if (normalised) events.push(normalised);
    }
    return events;
  }

  // ─── outbound ─────────────────────────────────────────────────────────
  async sendMessage(ctx: AccountContext, req: SendMessageRequest): Promise<SendResult> {
    const resp = await this.http.request<{ id: string; sent_at: string }>(
      `/api/${ctx.platformAccountId}/chats/${req.subscriberExternalId}/messages`,
      {
        method: "POST",
        idempotencyKey: req.idempotencyKey,
        body: { text: req.text },
      },
    );
    return { externalId: resp.id, sentAt: new Date(resp.sent_at) };
  }

  async sendPPV(ctx: AccountContext, req: SendPPVRequest): Promise<SendResult> {
    const resp = await this.http.request<{ id: string; sent_at: string }>(
      `/api/${ctx.platformAccountId}/chats/${req.subscriberExternalId}/messages`,
      {
        method: "POST",
        idempotencyKey: req.idempotencyKey,
        body: {
          text: req.caption ?? "",
          price_cents: req.priceCents,
          media_ids: [req.assetRef],
          is_ppv: true,
        },
      },
    );
    return { externalId: resp.id, sentAt: new Date(resp.sent_at) };
  }

  async markRead(ctx: AccountContext, conversationExternalId: string): Promise<void> {
    await this.http.request(`/api/${ctx.platformAccountId}/chats/${conversationExternalId}/read`, {
      method: "POST",
    });
  }

  // ─── lifecycle ────────────────────────────────────────────────────────
  async *listSubscribers(ctx: AccountContext, cursor?: string): AsyncIterable<SubscriberSnapshot> {
    let next = cursor ?? null;
    while (true) {
      const resp = await this.http.request<PlatformSubscribersResponse>(
        `/api/${ctx.platformAccountId}/fans`,
        { query: { cursor: next ?? undefined, limit: 100 } },
      );
      for (const s of resp.items) {
        yield normalizeSubscriber(s);
      }
      if (!resp.has_more) break;
      next = resp.next_cursor;
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

// ─── wire shapes (rename fields to match actual platform OpenAPI) ────────
interface PlatformInboxResponse {
  items: PlatformInboxItem[];
  next_cursor: string;
  has_more: boolean;
}

interface PlatformInboxItem {
  id: string;
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
  const rawKind = item.type ?? item.event;
  if (!rawKind) return null;
  const kind = mapEventKind(rawKind);
  if (!kind) return null;
  const subscriberExternalId =
    item.sender_id ??
    (item.from_user?.id != null ? String(item.from_user.id) : undefined) ??
    (item.data && typeof item.data === "object" && "user_id" in item.data
      ? String((item.data as { user_id: unknown }).user_id)
      : undefined);
  if (!subscriberExternalId) return null;

  const occurredAt = item.occurred_at ?? item.created_at ?? new Date().toISOString();
  return {
    externalId: item.id,
    kind,
    platformAccountId,
    subscriberExternalId,
    payload: item as Record<string, unknown>,
    occurredAt: new Date(occurredAt),
    ...(item.conversation_id !== undefined ? { conversationExternalId: item.conversation_id } : {}),
  };
}

function mapEventKind(type: string): PlatformEvent["kind"] | null {
  switch (type) {
    case "message":
    case "messages.received":
    case "message.received":
      return "message.received";
    case "subscription.started":
    case "subscriptions.new":
    case "subscribed":
      return "subscription.started";
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

function extractAccountId(item: PlatformInboxItem): string | null {
  if (typeof item.account_id === "string") return item.account_id;
  if (item.data && typeof item.data === "object") {
    const d = item.data as Record<string, unknown>;
    if (typeof d.account_id === "string") return d.account_id;
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
