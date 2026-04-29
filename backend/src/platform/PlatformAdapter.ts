/**
 * Name-agnostic interface over the creator platform (OF/Fanvue/future).
 * All platform-specific code lives under impl/<name>/ and MUST NOT leak past this boundary.
 *
 * Multi-creator: the adapter holds auth for the whole platform integration
 * (one API key / bearer token for the team). Account-scoped operations take
 * the internal accountId and the adapter resolves it to the platform's own
 * account id (stored on v3.accounts.platform_account_id).
 */

export type PlatformEventKind =
  | "message.received"
  | "subscription.started"
  | "subscription.expired"
  | "ppv.unlocked"
  | "tip.received";

export interface PlatformEvent {
  /** Stable ID from the platform for idempotency. */
  externalId: string;
  kind: PlatformEventKind;
  /** Platform's own account id for the creator this event targets. */
  platformAccountId: string;
  /** Platform's conversation/thread ID (if distinct from subscriber). */
  conversationExternalId?: string;
  /** Platform's user ID for the fan. */
  subscriberExternalId: string;
  /** Raw payload preserved for audit/replay. */
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface MessageEvent extends PlatformEvent {
  kind: "message.received";
  text: string;
  attachments: Array<{ kind: string; ref: string }>;
}

export interface SendMessageRequest {
  subscriberExternalId: string;
  text: string;
  /** Stable key so retries don't double-send. */
  idempotencyKey: string;
}

export interface SendPPVRequest {
  subscriberExternalId: string;
  /** Opaque reference to the asset on the platform. */
  assetRef: string;
  priceCents: number;
  caption?: string;
  idempotencyKey: string;
}

/**
 * Free preview send. Posts a media-attached DM with NO price field — distinct
 * from sendPPV which always includes price. OnlyFans treats `price > 0` as
 * the PPV signal, so we MUST omit price entirely for previews to land as a
 * normal in-DM photo/clip rather than a $0 paywalled bubble.
 */
export interface SendFreeMediaRequest {
  subscriberExternalId: string;
  /** Opaque media reference on the platform (preview_media_id from catalog). */
  mediaRef: string;
  /** Caption sent alongside the media — required, the n8n flow proves OFAPI accepts media + text. */
  caption: string;
  idempotencyKey: string;
}

export interface SendResult {
  externalId: string;
  sentAt: Date;
}

export interface SubscriberSnapshot {
  externalId: string;
  displayName?: string;
  subscribedAt?: Date;
  expiresAt?: Date;
  isActive: boolean;
  metadata: Record<string, unknown>;
}

export interface FanList {
  externalId: string;
  name: string;
  memberCount: number;
}

export interface BroadcastRequest {
  listExternalId: string;
  text: string;
  assetRef?: string;
  priceCents?: number;
  idempotencyKey: string;
}

export interface BroadcastResult {
  externalId: string;
  scheduledFor?: Date;
  recipientCount: number;
}

export interface FetchMissedResult {
  events: PlatformEvent[];
  /** Opaque cursor to pass back next call. */
  nextCursor: string;
  /** True if more events exist right now and caller should call again immediately. */
  hasMore: boolean;
}

export interface AdapterCapabilities {
  hasWebhooks: boolean;
  hasMassMessage: boolean;
  hasLists: boolean;
  hasReadReceipts: boolean;
  hasPPV: boolean;
}

/**
 * Per-account context the orchestrator hands to the adapter on every call.
 * The adapter uses `platformAccountId` to construct the upstream URL /
 * payload; `accountId` is carried for logging / audit only.
 */
export interface AccountContext {
  accountId: string;
  platformAccountId: string;
}

/** Raw webhook delivery as received by our HTTP ingress. */
export interface IncomingWebhook {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface PlatformAdapter {
  capabilities(): AdapterCapabilities;

  // inbound (per-account polling fallback when webhooks are down)
  fetchMissedSince(ctx: AccountContext, cursor: string | null): Promise<FetchMissedResult>;

  // inbound (webhook path) — single-shot verify + parse. Returns normalised
  // events tagged with platformAccountId; the HTTP ingress maps them to
  // internal accountIds via the accounts repo. Returns null if the signature
  // is invalid and the event should be rejected.
  parseWebhook(delivery: IncomingWebhook): PlatformEvent[] | null;

  // outbound
  sendMessage(ctx: AccountContext, req: SendMessageRequest): Promise<SendResult>;
  sendPPV(ctx: AccountContext, req: SendPPVRequest): Promise<SendResult>;
  sendFreeMedia(ctx: AccountContext, req: SendFreeMediaRequest): Promise<SendResult>;
  /**
   * Show "Model is typing..." in the fan's chat for ~4s. Free, fire-and-forget,
   * non-fatal — implementations MUST NOT throw on failure (we never fail a
   * send because typing indicator failed). Call multiple times to extend.
   */
  sendTypingIndicator(ctx: AccountContext, subscriberExternalId: string): Promise<void>;
  markRead(ctx: AccountContext, conversationExternalId: string): Promise<void>;

  // lifecycle
  listSubscribers(ctx: AccountContext, cursor?: string): AsyncIterable<SubscriberSnapshot>;
  listLists(ctx: AccountContext): Promise<FanList[]>;
  broadcastToList(ctx: AccountContext, req: BroadcastRequest): Promise<BroadcastResult>;
}
