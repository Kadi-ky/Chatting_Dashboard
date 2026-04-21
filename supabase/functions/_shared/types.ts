// Shared TS types for chat automation.
// Keep this file small — it's imported by every chat function.

export type Mood =
  | "horny"
  | "lonely"
  | "chatty"
  | "aggressive"
  | "hesitant";

export type Intent =
  | "just_talking"
  | "demanding_free_content"
  | "ready_to_buy"
  | "complaining";

export interface ClassifierOutput {
  mood: Mood;
  intent: Intent;
  confidence: number;       // 0..1
  should_respond: boolean;  // false for "bye", "gotta go", empty fragments, etc.
}

export interface ChatMessageRow {
  id: number;
  creator_uuid: string;
  fan_id: number;
  onlyfans_account_id: string;
  direction: "in" | "out";
  role: "user" | "assistant" | "system";
  content: string;
  status:
    | "received"
    | "drafted"
    | "sent"
    | "failed"
    | "suppressed";
  mood: Mood | null;
  intent: Intent | null;
  classifier_conf: number | null;
  model_used: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  send_after: string | null;
  sent_at: string | null;
  external_msg_id: string | null;
  external_event_id: string | null;
  created_at: string;
}

export interface SubscriberFact {
  id: number;
  key: string;
  value: string;
  category: "identity" | "preference" | "commerce" | "emotional";
  confidence: number;
}

export interface ConversationSummary {
  summary: string;
  last_message_id: number | null;
  message_count_at_summary: number;
}

export interface ChatContext {
  recent: ChatMessageRow[];            // L1 — verbatim
  summary: ConversationSummary | null; // L2 — rolling summary (may be null on new threads)
  facts: SubscriberFact[];             // L3 — structured facts (live only, superseded filtered out)
}
