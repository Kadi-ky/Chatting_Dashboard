import { sharedRedis } from "../queue/redis.js";

/**
 * Sticky disengagement flag.
 *
 * Operator-audit 2026-05-20 found 8 fans who explicitly said one of
 * "not interested" / "too expensive" / "broke" / "stop" / "leave me
 * alone" — and then received 27-113 more bot messages and 1-18 more
 * PPVs afterward. Most damning: fan 88582f59 said "Sorry not interested
 * but thanks" + "you are too expensive for me, charging $15 for 40
 * seconds" → bot acknowledged with "no pressure" → 2 minutes later
 * pitched a tip → 30 minutes later nudged again.
 *
 * The nudge + outreach workers' DISENGAGE_PATTERNS only look at the
 * last 3 inbounds. If the explicit "no" is older than 3 inbounds it
 * gets missed. Plus the chat-reply path (turn worker / orchestrator)
 * doesn't check this at all — bot can pitch in a chat reply even
 * when the fan said "stop" 2 messages ago.
 *
 * Fix: when an inbound matches an EXPLICIT REFUSAL pattern, set a
 * Redis flag on the conversation. The flag suppresses outbound
 * automation (pitches, nudges, vouchers, outreach) for 14 days.
 * Real two-way chat replies STILL FIRE if the fan messages again —
 * the goal is "stop pushing", not "stop talking". The flag is
 * cleared when the fan sends an explicit RE-ENGAGEMENT signal
 * (rejoin, sub, real conversation past the no).
 *
 * Distinct from `botDetection` — that's "this conversation is a bot,
 * skip the whole turn." This is "this fan said no, stop pitching
 * but reply naturally if they come back warmer."
 */

const DISENGAGE_FLAG_TTL_SEC = 14 * 24 * 3600; // 14 days

// EXPLICIT REFUSAL patterns — these are hard-no signals that should
// freeze automation. Distinct from "broke" (which triggers cant_afford
// discount path) — we DO want to discount-recover broke fans.
const EXPLICIT_NO_PATTERNS: RegExp[] = [
  /\bnot interested\b/i,
  /\bleave me alone\b/i,
  /\bstop (?:messaging|texting|contacting|sending)\b/i,
  /\bunsub(?:scribe)?\b/i,
  /\bdo not (?:contact|message|dm)\b/i,
  /\bgoodbye\b/i,
  /\bbye for good\b/i,
  /\bnot for me\b/i,
  /\btoo expensive\b/i,
  /\bcan'?t afford\b/i, // also triggers cant_afford intent — flag is additive
  /\bblock(?:ed|ing)?\b/i,
  /\bcanc(?:el|elled|elling)\b/i,
  // Temporal refusals — added 2026-05-25 after disengagement-audit agent
  // found 0 sticky_disengagement_flag firings in 50 decisions. Conv
  // 0923274f said "ILL TALK TO YOU SNOTHRR TIME" + "no money UNTIL TUE OR
  // WED" and got 2 drip PPVs ~hours later. These phrases are clear
  // "leave me alone for now" signals distinct from "broke" alone (which
  // we deliberately keep out of the freeze list so cant_afford can fire
  // a discount-recovery pitch).
  /\btalk to (?:you|u) (?:later|another time|next time|some other time|tomorrow|next week)\b/i,
  /\b(?:catch|hit) (?:you|u|ya) (?:later|up later|another time|next week|tomorrow)\b/i,
  /\bnot (?:until|till) (?:next week|payday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|tomorrow)\b/i,
  /\bsee (?:you|u|ya) (?:later|tomorrow|next week)\b/i,
  /\bhmu (?:later|tomorrow|next week)\b/i,
  /\bdone for (?:now|today|tonight|the day|the night)\b/i,
];

const disengageFlagKey = (conversationId: string): string =>
  `peach:conv:disengaged:${conversationId}`;

/**
 * Check if the text contains an explicit refusal signal.
 */
export function isExplicitDisengagement(text: string): boolean {
  if (!text) return false;
  return EXPLICIT_NO_PATTERNS.some((p) => p.test(text));
}

export async function markConversationDisengaged(conversationId: string): Promise<void> {
  const r = sharedRedis();
  await r.set(disengageFlagKey(conversationId), "1", "EX", DISENGAGE_FLAG_TTL_SEC);
}

export async function isConversationDisengaged(conversationId: string): Promise<boolean> {
  const r = sharedRedis();
  const v = await r.get(disengageFlagKey(conversationId));
  return v === "1";
}

/**
 * Explicit re-engagement: fan messages something positive after a previous
 * "no". Currently we clear on ANY incoming message of substantive length
 * (> 30 chars) that doesn't itself match the disengage patterns. Conservative
 * — most "ok hi" type messages are short and we don't unflag yet; longer
 * substantive replies signal the fan changed their mind.
 */
export async function maybeClearDisengageOnRetEngage(
  conversationId: string,
  text: string,
): Promise<void> {
  if (!text || text.length < 30) return;
  if (isExplicitDisengagement(text)) return; // they still don't want it
  const r = sharedRedis();
  await r.del(disengageFlagKey(conversationId)).catch(() => undefined);
}
