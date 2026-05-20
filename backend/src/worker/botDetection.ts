import { sharedRedis } from "../queue/redis.js";

/**
 * Bot-on-bot detection.
 *
 * Operator-audit 2026-05-20: one fan-side conversation (conv c59fd276)
 * was actually a competing chatter-bot, sending OF promo links and
 * generic flirt-bot questions interleaved. Our bot replied to all of
 * them, fired 12 PPVs and 95 outbound messages — pure wasted LLM
 * compute. Need to detect and freeze these threads.
 *
 * Patterns the chatter-bot was sending (real examples):
 *   - "Petite and spicy—Cecilia is waiting for you! https://onlyfans.com/cecilia.suarez/c80 #ad"
 *   - "Enter her realm… real men know the rules https://onlyfans.com/mariamzaid/c1 #ad"
 *   - "she's the kind of girl who'll steal your hoodie… and your heart https://onlyfans.com/francescaricci/c1 #ad"
 *
 * Common signals across competing-creator chatter-bots:
 *   - `#ad` hashtag (clear promo marker)
 *   - `onlyfans.com/<handle>/c<digits>` campaign-tracker URL pattern
 *   - "subscribe now" / "real men know" / "waiting for you" promo verbiage
 *   - Sometimes generic flirt questions ("Do you like sexting?",
 *     "What's a surefire way to turn you on?") interleaved.
 *
 * Detection strategy: any inbound matching ONE high-confidence pattern
 * (OF promo URL with campaign tracker OR explicit #ad) flags the
 * conversation. Single high-signal match is enough — false positive
 * cost (1 fan misread as bot) is low because the flag is reversible
 * via Redis DEL and only suppresses outbound, not inbound recording.
 */

const BOT_FLAG_TTL_SEC = 365 * 24 * 3600; // 1 year — these conversations are dead

// HIGH-CONFIDENCE: OF campaign tracker URL — used by promo bots, not humans
const OF_PROMO_URL = /onlyfans\.com\/[A-Za-z0-9_.-]+\/c\d+/i;
// HIGH-CONFIDENCE: explicit ad hashtag
const AD_HASHTAG = /#ad\b/i;
// MEDIUM (require URL or hashtag co-occurrence): generic promo verbiage that
// rarely appears in real fan messages but flirt-bots use as filler
const PROMO_VERBIAGE = /\b(?:subscribe now|real men know|waiting for you|enter her realm|steal your (?:heart|hoodie))\b/i;

const botFlagKey = (conversationId: string): string =>
  `peach:conv:bot:${conversationId}`;

/**
 * True if the inbound text looks like a competing chatter-bot promo.
 */
export function isBotInbound(text: string): boolean {
  if (!text) return false;
  if (OF_PROMO_URL.test(text)) return true;
  if (AD_HASHTAG.test(text)) return true;
  // Promo verbiage alone is too noisy — only flag if paired with an OF URL.
  if (PROMO_VERBIAGE.test(text) && /onlyfans\.com/i.test(text)) return true;
  return false;
}

export async function flagConversationAsBot(conversationId: string): Promise<void> {
  const r = sharedRedis();
  await r.set(botFlagKey(conversationId), "1", "EX", BOT_FLAG_TTL_SEC);
}

export async function isConversationBotFlagged(conversationId: string): Promise<boolean> {
  const r = sharedRedis();
  const v = await r.get(botFlagKey(conversationId));
  return v === "1";
}
