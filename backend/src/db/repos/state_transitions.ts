import { db } from "../client.js";
import type { Phase } from "../types.js";

export interface LogTransitionArgs {
  conversationId: string;
  fromPhase: Phase | null;
  toPhase: Phase;
  trigger: string;
  meta?: Record<string, unknown>;
}

export async function logStateTransition(args: LogTransitionArgs): Promise<void> {
  await db
    .insertInto("v3.state_transitions")
    .values({
      conversation_id: args.conversationId,
      from_phase: args.fromPhase,
      to_phase: args.toPhase,
      trigger: args.trigger,
      ...(args.meta ? { meta: JSON.stringify(args.meta) } : {}),
    })
    .execute();
}
