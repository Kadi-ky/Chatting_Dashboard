import type { Phase } from "../state/types.js";
import type { SpenderTier, EngagementLevel } from "../db/types.js";

/**
 * Declarative segment definition. All fields are AND-ed together; each field
 * accepts a single value or an inclusive set. Runs against subscribers +
 * archetypes + transactions rollups.
 */
export interface SegmentQuery {
  /** Subscriber is currently active (is_active=true) — default true. */
  active?: boolean;
  /** Spender tier from latest archetype. */
  spenderTier?: SpenderTier | SpenderTier[];
  /** Engagement level from latest archetype. */
  engagementLevel?: EngagementLevel | EngagementLevel[];
  /** Current conversation phase. */
  phase?: Phase | Phase[];
  /** Include only fans silent for at least N days since last inbound. */
  silentAtLeastDays?: number;
  /** Exclude fans active within the last N hours (avoids double-touching live convs). */
  excludeActiveWithinHours?: number;
  /** Fetish-tag overlap: at least one of these must appear in fan's archetype tags. */
  anyFetishTag?: string[];
  /** Cap the segment size deterministically (ordered by last_inbound_at desc). */
  limit?: number;
}

export interface CampaignTemplate {
  /** Plain text fallback; generator receives this as the objective hint. */
  prompt: string;
  /** Optional PPV asset to attach. Ranker is NOT used here — operator picks. */
  assetId?: string;
  priceOverrideCents?: number;
  /** Tone hint appended to the generator state directive. */
  tone?: string;
}

export interface SendWindow {
  /** ISO-8601 start/end. Sends are distributed across this window. */
  start: string;
  end: string;
  /** IANA timezone used to interpret the window relative to fans' offsets. */
  tz: string;
}

export interface RateCap {
  perMinute: number;
  perHour: number;
}

export interface CampaignConfig {
  accountId: string;
  name: string;
  segment: SegmentQuery;
  template: CampaignTemplate;
  window: SendWindow;
  rateCap: RateCap;
}
