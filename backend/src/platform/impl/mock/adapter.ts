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

/**
 * In-memory adapter for tests and local dev. Scripts push events onto the queue;
 * outbound sends are captured in `sent` for assertions.
 *
 * Ignores accountId — the V3 Testing Ground runs a single fake creator, and
 * the events it enqueues already carry the right platformAccountId on them.
 */
export class MockPlatformAdapter implements PlatformAdapter {
  private queue: PlatformEvent[] = [];
  public readonly sent: Array<{
    accountId: string;
    kind: "message" | "ppv" | "free_media";
    req: unknown;
    result: SendResult;
  }> = [];
  public readonly reads: Array<{ accountId: string; conversationExternalId: string }> = [];
  public readonly typingFires: Array<{ accountId: string; subscriberExternalId: string; at: Date }> = [];
  public readonly deletes: Array<{ accountId: string; chatId: string; messageExternalId: string; at: Date }> = [];

  enqueue(...events: PlatformEvent[]): void {
    this.queue.push(...events);
  }

  capabilities(): AdapterCapabilities {
    return {
      hasWebhooks: false,
      hasMassMessage: true,
      hasLists: true,
      hasReadReceipts: true,
      hasPPV: true,
    };
  }

  async fetchMissedSince(_ctx: AccountContext, _cursor: string | null): Promise<FetchMissedResult> {
    const events = this.queue.splice(0, this.queue.length);
    return { events, nextCursor: new Date().toISOString(), hasMore: false };
  }

  parseWebhook(_delivery: IncomingWebhook): PlatformEvent[] | null {
    // Mock mode has no webhook surface; the test harness pushes events via enqueue().
    return [];
  }

  async sendMessage(ctx: AccountContext, req: SendMessageRequest): Promise<SendResult> {
    const result: SendResult = {
      externalId: `mock-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sentAt: new Date(),
    };
    this.sent.push({ accountId: ctx.accountId, kind: "message", req, result });
    return result;
  }

  async sendPPV(ctx: AccountContext, req: SendPPVRequest): Promise<SendResult> {
    const result: SendResult = {
      externalId: `mock-ppv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sentAt: new Date(),
    };
    this.sent.push({ accountId: ctx.accountId, kind: "ppv", req, result });
    return result;
  }

  async sendFreeMedia(ctx: AccountContext, req: SendFreeMediaRequest): Promise<SendResult> {
    const result: SendResult = {
      externalId: `mock-preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sentAt: new Date(),
    };
    this.sent.push({ accountId: ctx.accountId, kind: "free_media", req, result });
    return result;
  }

  async sendTypingIndicator(ctx: AccountContext, subscriberExternalId: string): Promise<void> {
    this.typingFires.push({ accountId: ctx.accountId, subscriberExternalId, at: new Date() });
  }

  async deleteMessage(
    ctx: AccountContext,
    args: { chatId: string; messageExternalId: string },
  ): Promise<void> {
    this.deletes.push({
      accountId: ctx.accountId,
      chatId: args.chatId,
      messageExternalId: args.messageExternalId,
      at: new Date(),
    });
  }

  async markRead(ctx: AccountContext, conversationExternalId: string): Promise<void> {
    this.reads.push({ accountId: ctx.accountId, conversationExternalId });
  }

  async *listSubscribers(_ctx: AccountContext, _cursor?: string): AsyncIterable<SubscriberSnapshot> {
    // no-op
  }

  async listLists(_ctx: AccountContext): Promise<FanList[]> {
    return [];
  }

  async broadcastToList(_ctx: AccountContext, _req: BroadcastRequest): Promise<BroadcastResult> {
    return { externalId: `mock-bcast-${Date.now()}`, recipientCount: 0 };
  }
}
