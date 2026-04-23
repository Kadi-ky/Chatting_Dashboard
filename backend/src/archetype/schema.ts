import { z } from "zod";

export const SPENDER_TIERS = ["never", "low", "mid", "high", "whale"] as const;
export const ENGAGEMENT_LEVELS = ["lurker", "casual", "active", "obsessive"] as const;
export const RELATIONSHIP_TONES = [
  "friend",
  "romantic",
  "gfe",
  "dom",
  "sub",
  "fantasy",
  "transactional",
] as const;
export const PRICE_SENSITIVITIES = ["low", "mid", "high"] as const;
export const OBJECTION_PATTERNS = [
  "price",
  "trust",
  "time",
  "relationship",
  "content_fit",
] as const;

export const archetypeSchema = z.object({
  spenderTier: z.enum(SPENDER_TIERS),
  confidence: z.number().min(0).max(1),
  fetishTags: z.array(z.string().min(1).max(48)).max(12).default([]),
  engagementLevel: z.enum(ENGAGEMENT_LEVELS),
  relationshipTone: z.enum(RELATIONSHIP_TONES),
  priceSensitivity: z.enum(PRICE_SENSITIVITIES),
  objectionPatterns: z.array(z.enum(OBJECTION_PATTERNS)).max(OBJECTION_PATTERNS.length).default([]),
  timeZoneHint: z.string().max(64).nullable().default(null),
  pivotSignals: z.array(z.string().min(1).max(240)).max(6).default([]),
});

export type ArchetypeOutput = z.infer<typeof archetypeSchema>;

export const ARCHETYPE_OUTPUT_SPEC = `Return JSON:
{
  "spenderTier": "never"|"low"|"mid"|"high"|"whale",
  "confidence": 0..1,
  "fetishTags": string[],
  "engagementLevel": "lurker"|"casual"|"active"|"obsessive",
  "relationshipTone": "friend"|"romantic"|"gfe"|"dom"|"sub"|"fantasy"|"transactional",
  "priceSensitivity": "low"|"mid"|"high",
  "objectionPatterns": ("price"|"trust"|"time"|"relationship"|"content_fit")[],
  "timeZoneHint": string|null,
  "pivotSignals": string[]
}
Only output the JSON. No preamble.`;

export const CLASSIFIER_VERSION = "v1.0";
