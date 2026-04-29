/**
 * In-memory ring buffers exposed via /diag endpoints. Process-local — clears
 * on restart. The point is operator visibility into things that go wrong
 * (or silently skip) without needing to tail Railway logs.
 *
 * Three rings:
 *   - WEBHOOK_EVENTS  — last N webhook receives with parse status
 *   - SKIP_REASONS    — last N times the turn worker did NOT reply, with reason
 *   - (existing rings live elsewhere: recent-errors, recent-pitches, recent-nudges)
 */

const MAX = 100;

// ─── Webhook events ────────────────────────────────────────────────────────

export interface WebhookEventEntry {
  at: string;
  path: string;
  sourceIp: string | null;
  trusted: boolean;
  /** Number of events parsed out of the body. 0 means parse returned null/empty. */
  parsed: number;
  enqueued: number;
  blockedByAllowlist: number;
  unknownAccounts: number;
  parseError?: string;
  signatureInvalid?: boolean;
}

const WEBHOOK_EVENTS: WebhookEventEntry[] = [];
export function recordWebhookEvent(entry: WebhookEventEntry): void {
  WEBHOOK_EVENTS.unshift(entry);
  if (WEBHOOK_EVENTS.length > MAX) WEBHOOK_EVENTS.length = MAX;
}
export function getRecentWebhookEvents(): WebhookEventEntry[] {
  return WEBHOOK_EVENTS.slice();
}

// ─── Skip reasons (silent or noisy turn-worker reply skips) ────────────────

export type SkipReason =
  | "takeover"
  | "no_unread_inbound"
  | "no_text_content"
  | "state_tick_null"
  | "lock_contention"
  | "generator_returned_null"
  | "generator_parse_failed"
  | "safety_refusal"
  | "humanizer_zero_bubbles"
  | "worker_hard_timeout"
  | "worker_threw"
  | "other";

export interface SkipReasonEntry {
  at: string;
  conversationId: string;
  reason: SkipReason;
  detail?: string;
}

const SKIP_REASONS: SkipReasonEntry[] = [];
export function recordSkipReason(entry: Omit<SkipReasonEntry, "at">): void {
  SKIP_REASONS.unshift({ at: new Date().toISOString(), ...entry });
  if (SKIP_REASONS.length > MAX) SKIP_REASONS.length = MAX;
}
export function getRecentSkipReasons(): SkipReasonEntry[] {
  return SKIP_REASONS.slice();
}
