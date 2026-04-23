import { db } from "../db/client.js";
import type { LlmMessage } from "../llm/types.js";

/**
 * Write a complete record of a single turn's reasoning so the admin UI can
 * render "why did it say this" without replaying the run. We already persist
 * llm_calls; this wraps the same row with the per-turn metadata operators
 * care about (phase, humanness diff, pitch decision).
 *
 * Implementation note: we re-use the llm_calls table by writing richer meta;
 * no new table needed until we want native audit queries.
 */
export interface TurnAudit {
  conversationId: string;
  subscriberId: string;
  turnIndex: number;
  phase: string;
  assembledPrompt: LlmMessage[];
  rawGeneratorOutput?: string;
  parsedBubbles?: string[];
  humanizedBubbles?: string[];
  pitchDecision?: {
    shouldPitch: boolean;
    reason: string;
    assetId?: string | null;
    priceCents?: number | null;
  };
  llmCallId?: string | null;
}

/**
 * Append an audit trail record onto the llm_calls row for this turn. We do an
 * UPDATE rather than an insert — the row already exists with request/response.
 * Operators view it via an admin endpoint that joins conversations → llm_calls
 * by conversation_id in the request meta.
 */
export async function recordTurnAudit(audit: TurnAudit): Promise<void> {
  if (!audit.llmCallId) return;

  const meta = {
    conversationId: audit.conversationId,
    subscriberId: audit.subscriberId,
    turnIndex: audit.turnIndex,
    phase: audit.phase,
    assembledPrompt: audit.assembledPrompt,
    parsedBubbles: audit.parsedBubbles ?? [],
    humanizedBubbles: audit.humanizedBubbles ?? [],
    pitchDecision: audit.pitchDecision ?? null,
  };

  await db
    .updateTable("v3.llm_calls")
    .set({ response: JSON.stringify({ raw: audit.rawGeneratorOutput ?? null, audit: meta }) })
    .where("id", "=", audit.llmCallId)
    .execute();
}
