import type { ColumnType, Generated } from "kysely";

export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type Numeric = ColumnType<string, number | string, number | string>;
/**
 * numeric column with a DB-side default. Insert is optional. Use this instead
 * of `Generated<Numeric>` — nesting ColumnTypes breaks Kysely's `InsertType`.
 */
export type GeneratedNumeric = ColumnType<string, number | string | undefined, number | string>;

/**
 * jsonb column (required on insert). Selects return the parsed object; inserts
 * take a JSON-stringified value. Use `JSON.stringify(obj)` at call sites.
 */
export type Json<T = Record<string, unknown>> = ColumnType<T, string, string>;

/**
 * jsonb column with a DB-side default. Insert is optional; update takes string.
 * Use this instead of `Generated<Json<T>>` — nesting ColumnTypes breaks Kysely's
 * `InsertType` unwrap.
 */
export type GeneratedJson<T = Record<string, unknown>> = ColumnType<T, string | undefined, string>;

// ─── enums ──────────────────────────────────────────────────────────────
export type Phase =
  | "WARMUP"
  | "RAPPORT"
  | "QUALIFYING"
  | "MONETIZING"
  | "WHALE"
  | "REACTIVATION"
  | "COLD";

export type MessageDirection = "inbound" | "outbound" | "system";
export type MessageKind =
  | "text"
  | "ppv"
  | "unlock"
  | "tip"
  | "subscription"
  | "system_event";

export type SpenderTier = "never" | "low" | "mid" | "high" | "whale";
export type EngagementLevel = "lurker" | "casual" | "active" | "obsessive";
export type RelationshipTone =
  | "friend"
  | "romantic"
  | "gfe"
  | "dom"
  | "sub"
  | "fantasy"
  | "transactional";
export type PriceSensitivity = "low" | "mid" | "high";
export type PpvOutcome = "pending" | "unlocked" | "expired" | "declined";
export type TransactionKind = "subscription" | "ppv_unlock" | "tip" | "other";
export type CampaignStatus =
  | "draft"
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "cancelled";
export type CampaignSendStatus = "scheduled" | "sent" | "failed" | "skipped";

// ─── tables ─────────────────────────────────────────────────────────────
export interface AccountsTable {
  id: Generated<string>;
  name: string;
  persona_version: Generated<string>;
  status: Generated<string>;
  config: GeneratedJson<Record<string, unknown>>;
  platform: Generated<string>;
  // Platform's own account id (e.g. OnlyFansAPI `acct_xxx`). Nullable while
  // an account is being provisioned / reconnected.
  platform_account_id: string | null;
  // Maps to legacy content_inventory_onlyfans.creator_uuid + purchases_onlyfans.creator_uuid.
  creator_uuid: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface SubscribersTable {
  id: Generated<string>;
  account_id: string;
  external_id: string;
  display_name: string | null;
  platform_metadata: GeneratedJson<Record<string, unknown>>;
  subscribed_at: Timestamp | null;
  expires_at: Timestamp | null;
  is_active: Generated<boolean>;
  total_spend_cents: Generated<number>;
  spend_30d_cents: Generated<number>;
  last_inbound_at: Timestamp | null;
  last_outbound_at: Timestamp | null;
  timezone: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface SubscriberFactsTable {
  id: Generated<string>;
  subscriber_id: string;
  key: string;
  value: string;
  confidence: GeneratedNumeric;
  source_message_id: string | null;
  created_at: Generated<Timestamp>;
  superseded_by: string | null;
}

export interface ConversationsTable {
  id: Generated<string>;
  subscriber_id: string;
  account_id: string;
  phase: Generated<Phase>;
  substate: string | null;
  phase_entered_at: Generated<Timestamp>;
  turns_in_phase: Generated<number>;
  state_ctx: GeneratedJson<Record<string, unknown>>;
  last_activity_at: Generated<Timestamp>;
  created_at: Generated<Timestamp>;
}

export interface MessagesTable {
  id: Generated<string>;
  conversation_id: string;
  direction: MessageDirection;
  kind: Generated<MessageKind>;
  text: string | null;
  attachments: GeneratedJson<unknown[]>;
  external_id: string | null;
  llm_call_id: string | null;
  created_at: Generated<Timestamp>;
  sent_at: Timestamp | null;
  delivered_at: Timestamp | null;
}

export interface ArchetypesTable {
  id: Generated<string>;
  subscriber_id: string;
  classified_at: Generated<Timestamp>;
  classifier_version: Generated<string>;
  spender_tier: SpenderTier;
  confidence: Numeric;
  fetish_tags: string[];
  engagement_level: EngagementLevel;
  relationship_tone: RelationshipTone;
  price_sensitivity: PriceSensitivity;
  objection_patterns: string[];
  timezone_hint: string | null;
  pivot_signals: string[];
  raw: Json<Record<string, unknown>> | null;
}

export interface PpvCatalogTable {
  id: Generated<string>;
  account_id: string;
  title: string;
  description: string | null;
  media_refs: GeneratedJson<unknown[]>;
  tags: string[];
  price_floor_cents: number;
  price_ceiling_cents: number;
  created_at: Generated<Timestamp>;
  retired_at: Timestamp | null;
  attempts_count: Generated<number>;
  unlocks_count: Generated<number>;
  revenue_cents: Generated<number>;
  source_ref: string | null;
}

export interface AssetPerformanceTable {
  id: Generated<string>;
  asset_id: string;
  archetype_slice: Json<Record<string, unknown>>;
  attempts: Generated<number>;
  unlocks: Generated<number>;
  revenue_cents: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface PpvAttemptsTable {
  id: Generated<string>;
  conversation_id: string;
  asset_id: string;
  price_cents: number;
  pitched_at: Generated<Timestamp>;
  unlocked_at: Timestamp | null;
  expired_at: Timestamp | null;
  message_id: string | null;
  outcome: Generated<PpvOutcome>;
}

export interface TransactionsTable {
  id: Generated<string>;
  subscriber_id: string;
  kind: TransactionKind;
  amount_cents: number;
  occurred_at: Timestamp;
  external_id: string | null;
  metadata: GeneratedJson<Record<string, unknown>>;
  created_at: Generated<Timestamp>;
}

export interface StateTransitionsTable {
  id: Generated<string>;
  conversation_id: string;
  from_phase: Phase | null;
  to_phase: Phase;
  trigger: string;
  meta: GeneratedJson<Record<string, unknown>>;
  at: Generated<Timestamp>;
}

export interface LlmCallsTable {
  id: Generated<string>;
  task: string;
  provider: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_cents: Numeric | null;
  latency_ms: number | null;
  ok: boolean;
  error: string | null;
  request: Json<Record<string, unknown>> | null;
  response: Json<Record<string, unknown>> | null;
  created_at: Generated<Timestamp>;
}

export interface EventsTable {
  id: Generated<string>;
  account_id: string;
  kind: string;
  external_id: string | null;
  payload: Json<Record<string, unknown>>;
  received_at: Generated<Timestamp>;
  processed_at: Timestamp | null;
}

export interface CampaignsTable {
  id: Generated<string>;
  account_id: string;
  name: string;
  segment_query: Json<Record<string, unknown>>;
  template: Json<Record<string, unknown>>;
  send_window: Json<Record<string, unknown>>;
  rate_cap: GeneratedJson<Record<string, unknown>>;
  status: Generated<CampaignStatus>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CampaignSendsTable {
  id: Generated<string>;
  campaign_id: string;
  subscriber_id: string;
  scheduled_at: Timestamp;
  sent_at: Timestamp | null;
  status: Generated<CampaignSendStatus>;
  reply_received_at: Timestamp | null;
  error: string | null;
}

// Legacy tables (public schema) still driving content + purchases.
export interface ContentInventoryOnlyfansTable {
  id: Generated<string>;
  script_number: number;
  script_name: string | null;
  preview_media_id: string | null;
  ppv1_media_id: string | null;
  ppv1_price: Generated<number>;
  ppv1_description: string | null;
  ppv2_media_id: string | null;
  ppv2_price: Generated<number>;
  ppv2_description: string | null;
  ppv3_media_id: string | null;
  ppv3_price: Generated<number>;
  ppv3_description: string | null;
  ppv4_media_id: string | null;
  ppv4_price: Generated<number>;
  ppv4_description: string | null;
  creator_uuid: string | null;
  creator_name: string | null;
  tag_creator: string | null;
  tags: Generated<string[]>;
}

export interface PurchasesOnlyfansTable {
  id: Generated<number>;
  fan_uuid: string;
  script_number: number | null;
  rung: number | null;
  amount: Numeric | null;
  // DB default is now(); insert remains optional (pass Date|string when known).
  purchased_at: ColumnType<Date, Date | string | undefined, Date | string>;
  creator_uuid: string | null;
}

// ─── DB root (schema-qualified table names for Kysely) ──────────────────
export interface DB {
  "v3.accounts": AccountsTable;
  "v3.subscribers": SubscribersTable;
  "v3.subscriber_facts": SubscriberFactsTable;
  "v3.conversations": ConversationsTable;
  "v3.messages": MessagesTable;
  "v3.archetypes": ArchetypesTable;
  "v3.ppv_catalog": PpvCatalogTable;
  "v3.asset_performance": AssetPerformanceTable;
  "v3.ppv_attempts": PpvAttemptsTable;
  "v3.transactions": TransactionsTable;
  "v3.state_transitions": StateTransitionsTable;
  "v3.llm_calls": LlmCallsTable;
  "v3.events": EventsTable;
  "v3.campaigns": CampaignsTable;
  "v3.campaign_sends": CampaignSendsTable;
  "public.content_inventory_onlyfans": ContentInventoryOnlyfansTable;
  "public.purchases_onlyfans": PurchasesOnlyfansTable;
}
