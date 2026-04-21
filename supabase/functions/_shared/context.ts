// buildContext — assembles the 3-layer memory for a (creator, fan) thread.
//
//   L1 — last N verbatim messages  (chat_messages)
//   L2 — rolling summary           (conversation_summaries)
//   L3 — live structured facts     (subscriber_facts, superseded_by IS NULL)
//
// Returns everything the worker needs to build the Grok prompt.
// Summary regeneration + fact extraction are Phase 2 — this file only reads.

import { supabase } from "./supabase.ts";
import type {
  ChatContext,
  ChatMessageRow,
  ConversationSummary,
  SubscriberFact,
} from "./types.ts";

const VERBATIM_LIMIT = 20;  // L1 — last 20 messages
const FACT_LIMIT = 15;      // L3 — top 15 live facts

export async function buildContext(
  creatorUuid: string,
  fanId: number,
): Promise<ChatContext> {
  // Fire all three queries in parallel — they're independent.
  const [recentRes, summaryRes, factsRes] = await Promise.all([
    supabase
      .from("chat_messages")
      .select(
        "id, creator_uuid, fan_id, onlyfans_account_id, direction, role, content, status, mood, intent, classifier_conf, model_used, prompt_tokens, completion_tokens, send_after, sent_at, external_msg_id, external_event_id, created_at",
      )
      .eq("creator_uuid", creatorUuid)
      .eq("fan_id", fanId)
      .in("status", ["received", "drafted", "sent"])
      .order("created_at", { ascending: false })
      .limit(VERBATIM_LIMIT),

    supabase
      .from("conversation_summaries")
      .select("summary, last_message_id, message_count_at_summary")
      .eq("creator_uuid", creatorUuid)
      .eq("fan_id", fanId)
      .maybeSingle(),

    supabase
      .from("subscriber_facts")
      .select("id, key, value, category, confidence")
      .eq("creator_uuid", creatorUuid)
      .eq("fan_id", fanId)
      .is("superseded_by", null)
      .order("confidence", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(FACT_LIMIT),
  ]);

  if (recentRes.error) throw recentRes.error;
  if (summaryRes.error) throw summaryRes.error;
  if (factsRes.error)   throw factsRes.error;

  // L1 comes back newest-first from SQL; reverse for chronological feed into the model.
  const recent = ((recentRes.data ?? []) as ChatMessageRow[]).reverse();

  return {
    recent,
    summary: (summaryRes.data ?? null) as ConversationSummary | null,
    facts: (factsRes.data ?? []) as SubscriberFact[],
  };
}

/** Render L2 + L3 into a compact system-prompt block for injection. */
export function renderContextBlock(ctx: ChatContext): string {
  const parts: string[] = [];

  if (ctx.facts.length > 0) {
    const lines = ctx.facts.map((f) => `- ${f.key}: ${f.value}`);
    parts.push("What you know about this fan:\n" + lines.join("\n"));
  }

  if (ctx.summary?.summary) {
    parts.push("Summary of your history with them:\n" + ctx.summary.summary);
  }

  return parts.join("\n\n");
}
