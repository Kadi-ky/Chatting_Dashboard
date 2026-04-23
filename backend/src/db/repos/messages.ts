import { db } from "../client.js";
import type { MessageDirection, MessageKind } from "../types.js";

export interface InsertMessageArgs {
  conversationId: string;
  direction: MessageDirection;
  kind?: MessageKind;
  text?: string | null;
  attachments?: unknown[];
  externalId?: string | null;
  llmCallId?: string | null;
  sentAt?: Date | null;
}

export async function insertMessage(args: InsertMessageArgs): Promise<{ id: string } | null> {
  const row = await db
    .insertInto("v3.messages")
    .values({
      conversation_id: args.conversationId,
      direction: args.direction,
      kind: args.kind ?? "text",
      text: args.text ?? null,
      ...(args.attachments && args.attachments.length > 0
        ? { attachments: JSON.stringify(args.attachments) }
        : {}),
      external_id: args.externalId ?? null,
      llm_call_id: args.llmCallId ?? null,
      sent_at: args.sentAt ?? null,
    })
    .onConflict((oc) =>
      oc
        .columns(["conversation_id", "external_id"])
        .where("external_id", "is not", null)
        .doNothing(),
    )
    .returning(["id"])
    .executeTakeFirst();
  return row ?? null;
}

export interface InsertOutboundDraftArgs {
  conversationId: string;
  kind?: MessageKind;
  text: string;
  attachments?: unknown[];
  llmCallId?: string | null;
}

/**
 * Insert an outbound message row in draft state (not yet sent). Returns the
 * generated id so the outbound queue can reference it. sent_at stays null
 * until markMessageSent runs after the adapter returns.
 */
export async function insertOutboundDraft(args: InsertOutboundDraftArgs): Promise<{ id: string }> {
  const row = await db
    .insertInto("v3.messages")
    .values({
      conversation_id: args.conversationId,
      direction: "outbound",
      kind: args.kind ?? "text",
      text: args.text,
      ...(args.attachments && args.attachments.length > 0
        ? { attachments: JSON.stringify(args.attachments) }
        : {}),
      llm_call_id: args.llmCallId ?? null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export async function markMessageSent(
  messageId: string,
  externalId: string,
  sentAt: Date,
): Promise<void> {
  await db
    .updateTable("v3.messages")
    .set({ external_id: externalId, sent_at: sentAt })
    .where("id", "=", messageId)
    .execute();
}

export interface RecentMessage {
  direction: MessageDirection;
  kind: MessageKind;
  text: string | null;
  attachments: unknown[];
  createdAt: Date;
}

/**
 * Load all inbound messages that arrived after the most recent outbound reply
 * in this conversation. Used by the burst coalescer so the turn worker can
 * react to the whole burst as one, passing the concatenated text (and the
 * latest message's external id as a watermark) into the reply pipeline.
 *
 * If no outbound reply exists yet, returns every inbound message.
 */
export async function loadUnrepliedInbound(
  conversationId: string,
): Promise<{ id: string; text: string | null; createdAt: Date }[]> {
  const lastOut = await db
    .selectFrom("v3.messages")
    .select(["created_at"])
    .where("conversation_id", "=", conversationId)
    .where("direction", "=", "outbound")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();

  let q = db
    .selectFrom("v3.messages")
    .select(["id", "text", "created_at"])
    .where("conversation_id", "=", conversationId)
    .where("direction", "=", "inbound");

  if (lastOut) {
    q = q.where("created_at", ">", lastOut.created_at);
  }

  const rows = await q.orderBy("created_at", "asc").execute();
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    createdAt: r.created_at as unknown as Date,
  }));
}

/**
 * Load the last N inbound messages, oldest first. Used by the fact extractor
 * so a fact spanning two turns ("i have a dog" / "his name is claude") gets
 * joined when neither message alone contains the whole fact.
 */
export async function loadRecentInbound(
  conversationId: string,
  limit: number,
): Promise<{ text: string; createdAt: Date }[]> {
  const rows = await db
    .selectFrom("v3.messages")
    .select(["text", "created_at"])
    .where("conversation_id", "=", conversationId)
    .where("direction", "=", "inbound")
    .where("text", "is not", null)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows
    .reverse()
    .map((r) => ({ text: r.text as string, createdAt: r.created_at as unknown as Date }));
}

/**
 * Load the last N messages for a conversation, oldest first. Used by the
 * prompt assembler to build L7 context. System-direction rows are excluded
 * since they represent internal events, not things the fan wrote.
 */
export async function loadRecentMessages(
  conversationId: string,
  limit: number,
): Promise<RecentMessage[]> {
  const rows = await db
    .selectFrom("v3.messages")
    .select(["direction", "kind", "text", "attachments", "created_at"])
    .where("conversation_id", "=", conversationId)
    .where("direction", "in", ["inbound", "outbound"])
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.reverse().map((r) => ({
    direction: r.direction,
    kind: r.kind,
    text: r.text,
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
    createdAt: r.created_at as unknown as Date,
  }));
}
