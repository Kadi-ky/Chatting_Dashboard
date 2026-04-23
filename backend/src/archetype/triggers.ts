import {
  countInboundSinceLastArchetype,
  loadLatestArchetype,
} from "../db/repos/archetypes.js";
import { db } from "../db/client.js";
import type { ClassifierDepth } from "./classifier.js";

/**
 * Decide whether to re-classify this turn, and at what depth. Rules (first match):
 *
 *   - First 3 inbound messages of a subscriber: quick classify every turn until we have 3 msgs
 *   - Every 10 inbound messages since last classify: full
 *   - Every 24h on an active conversation: full
 *   - Explicit purchase/rejection event passed in: partial
 *
 * Returns null if no classification is needed this turn.
 */
export async function decideClassifierTrigger(args: {
  subscriberId: string;
  /** If true, caller observed a ppv.unlocked / declined / tip event this turn. */
  purchaseEvent?: boolean;
}): Promise<ClassifierDepth | null> {
  if (args.purchaseEvent) return "partial";

  const latest = await loadLatestArchetype(args.subscriberId);
  if (!latest) {
    // Seed pass — count inbound messages ever.
    const countRow = await db
      .selectFrom("v3.messages")
      .innerJoin("v3.conversations", "v3.conversations.id", "v3.messages.conversation_id")
      .select(db.fn.count<string>("v3.messages.id").as("count"))
      .where("v3.conversations.subscriber_id", "=", args.subscriberId)
      .where("v3.messages.direction", "=", "inbound")
      .executeTakeFirst();
    const total = Number(countRow?.count ?? 0);
    if (total <= 3) return "quick";
    return "full";
  }

  const since = await countInboundSinceLastArchetype(args.subscriberId);
  if (since >= 10) return "full";

  const ageHours = (Date.now() - latest.classifiedAt.getTime()) / 3_600_000;
  if (ageHours >= 24 && since >= 1) return "full";

  return null;
}
