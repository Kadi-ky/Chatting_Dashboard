import type { LatestArchetypeRow } from "../../db/repos/archetypes.js";

/**
 * L5 — ARCHETYPE. Renders a compact directive the generator can use to shape
 * tone, pricing, and objection framing. Keep this short: the generator reads
 * many system messages and long archetype prose adds noise, not signal.
 */
export function renderArchetypeDirective(a: LatestArchetypeRow): string {
  const tagLine = a.fetishTags.length > 0 ? `into: ${a.fetishTags.slice(0, 6).join(", ")}.` : "";
  const objLine =
    a.objectionPatterns.length > 0
      ? `typical objections: ${a.objectionPatterns.join(", ")}.`
      : "";
  const approach = pickApproach(a);

  return [
    `This fan: ${a.spenderTier} spender, ${a.priceSensitivity} price-sensitivity, ${a.engagementLevel} engagement, ${a.relationshipTone} tone.`,
    tagLine,
    objLine,
    `Approach: ${approach}`,
  ]
    .filter((s) => s.length > 0)
    .join(" ");
}

function pickApproach(a: LatestArchetypeRow): string {
  if (a.spenderTier === "whale") {
    return "attentive, familiar, VIP. Don't rush. Anchor higher.";
  }
  if (a.spenderTier === "never") {
    return "light tease, no price mention unless they ask. Don't waste effort.";
  }
  if (a.priceSensitivity === "high") {
    return "anchor low, frame any offer as 'just for you'. Don't escalate after first objection.";
  }
  if (a.priceSensitivity === "low" && a.spenderTier === "high") {
    return "anchor at mid-to-high, bundles and exclusives welcome.";
  }
  switch (a.relationshipTone) {
    case "gfe":
      return "girlfriend energy. Warm, inside-jokes, remember small things.";
    case "dom":
      return "let them lead tone. Short replies, receptive.";
    case "sub":
      return "confident, in charge. You decide when to tease and when to pitch.";
    case "fantasy":
      return "lean into the scenario they seeded. Avoid real-world specifics.";
    case "transactional":
      return "clear offers, low small-talk, keep the loop tight.";
    case "romantic":
      return "slow build, emotional cues, pitch only when the moment fits.";
    default:
      return "friendly, playful, read their energy.";
  }
}
