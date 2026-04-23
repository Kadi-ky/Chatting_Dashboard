import { sql } from "kysely";
import { db } from "../client.js";
import type { Phase } from "../types.js";

export async function ensureConversation(args: {
  subscriberId: string;
  accountId: string;
}): Promise<{ id: string }> {
  const row = await db
    .insertInto("v3.conversations")
    .values({
      subscriber_id: args.subscriberId,
      account_id: args.accountId,
    })
    .onConflict((oc) =>
      oc.column("subscriber_id").doUpdateSet({
        last_activity_at: sql`now()`,
      }),
    )
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export async function touchConversation(conversationId: string): Promise<void> {
  await db
    .updateTable("v3.conversations")
    .set({ last_activity_at: sql`now()` })
    .where("id", "=", conversationId)
    .execute();
}

/**
 * Monotonic turn index for a conversation. Used to seed the humanness RNG so
 * the same fan sees a consistent style across turns. Counts both directions
 * so the index advances on every exchange, not just fan messages.
 */
export async function countConversationTurns(conversationId: string): Promise<number> {
  const row = await db
    .selectFrom("v3.messages")
    .select(db.fn.count<string>("id").as("count"))
    .where("conversation_id", "=", conversationId)
    .where("direction", "in", ["inbound", "outbound"])
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export interface ConversationStateRow {
  id: string;
  phase: Phase;
  substate: string | null;
  phaseEnteredAt: Date;
  turnsInPhase: number;
  stateCtx: Record<string, unknown>;
}

export async function loadConversationState(conversationId: string): Promise<ConversationStateRow | null> {
  const row = await db
    .selectFrom("v3.conversations")
    .select(["id", "phase", "substate", "phase_entered_at", "turns_in_phase", "state_ctx"])
    .where("id", "=", conversationId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    phase: row.phase,
    substate: row.substate,
    phaseEnteredAt: row.phase_entered_at as unknown as Date,
    turnsInPhase: row.turns_in_phase,
    stateCtx: (row.state_ctx ?? {}) as Record<string, unknown>,
  };
}

/** Increment turns_in_phase by 1 on every turn. */
export async function bumpTurnsInPhase(conversationId: string): Promise<void> {
  await db
    .updateTable("v3.conversations")
    .set({ turns_in_phase: sql<number>`turns_in_phase + 1` })
    .where("id", "=", conversationId)
    .execute();
}

/**
 * Apply a phase transition: set the new phase, reset turns_in_phase to 0,
 * update phase_entered_at to now. Returns nothing — callers persist to
 * state_transitions separately for audit.
 */
export async function applyPhaseTransition(conversationId: string, to: Phase): Promise<void> {
  await db
    .updateTable("v3.conversations")
    .set({
      phase: to,
      turns_in_phase: 0,
      phase_entered_at: sql`now()`,
    })
    .where("id", "=", conversationId)
    .execute();
}
