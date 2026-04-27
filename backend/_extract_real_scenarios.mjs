// Extract interesting real conversations from fan_interactions_onlyfans and
// emit them as regression scenarios. Each session_id becomes one scenario.
//
// "Interesting" = multi-turn, real-creator, varied lengths, recent. We only
// keep the FAN's messages as inbound (the bot's old replies are kept in the
// scenario as ground truth for later comparison but NOT replayed).
//
// Usage:
//   node backend/_extract_real_scenarios.mjs              # default 30 sessions
//   node backend/_extract_real_scenarios.mjs --limit 100  # bigger set
//
// Output written to loop/regression/scenarios/real-extracted.json so the
// regression runner picks them up automatically.
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const argLimit = (() => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : 30;
})();

const txt = await fs.readFile('.env.local', 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();

// 1. Find session_ids from the prod creator with reasonable conversation
// length. Mix: short (3-6 inbound), medium (7-15), long (16+). Skew toward
// recent so the persona references make sense to the current bot.
const SAMPLE_SQL = `
  WITH session_stats AS (
    SELECT
      session_id,
      creatoruuid,
      COUNT(*) FILTER (WHERE direction = 'inbound')  AS fan_msgs,
      COUNT(*) FILTER (WHERE direction = 'outbound') AS bot_msgs,
      MAX(created_at) AS last_at
    FROM fan_interactions_onlyfans
    WHERE creatoruuid = 'acct_5d32685ee72144e9a1fc1ce9bde8edc6'
    GROUP BY session_id, creatoruuid
  )
  SELECT session_id, fan_msgs, bot_msgs, last_at
  FROM session_stats
  WHERE fan_msgs BETWEEN 2 AND 20
    AND bot_msgs BETWEEN 2 AND 30
  ORDER BY random()
  LIMIT $1
`;

const sessions = await c.query(SAMPLE_SQL, [argLimit]);
console.log(`sampled ${sessions.rows.length} candidate sessions`);

const scenarios = [];
let skipped = 0;

for (const s of sessions.rows) {
  const msgs = await c.query(
    `SELECT direction, message, created_at
     FROM fan_interactions_onlyfans
     WHERE session_id = $1 AND creatoruuid = 'acct_5d32685ee72144e9a1fc1ce9bde8edc6'
     ORDER BY created_at ASC`,
    [s.session_id],
  );

  // Strip HTML tags + collapse whitespace; messages with junk content are skipped.
  const cleaned = msgs.rows.map((r) => ({
    direction: r.direction,
    text: cleanText(r.message?.content ?? ''),
  })).filter((m) => m.text.length > 0 && m.text.length < 800);

  // Need at least 2 fan messages to make a useful scenario.
  const fanMessages = cleaned.filter((m) => m.direction === 'inbound').map((m) => m.text);
  const botGroundTruth = cleaned.filter((m) => m.direction === 'outbound').map((m) => m.text);
  if (fanMessages.length < 2) {
    skipped++;
    continue;
  }
  // Skip if any single fan message looks like garbage (just emojis, just punctuation).
  if (fanMessages.every((m) => m.length < 3)) {
    skipped++;
    continue;
  }

  scenarios.push({
    id: `real-${s.session_id}`,
    description: `Real conversation replay (session ${s.session_id}) — ${fanMessages.length} fan turns, ${botGroundTruth.length} ground-truth bot turns`,
    source: 'fan_interactions_onlyfans',
    sessionId: s.session_id,
    fanMessages,
    botGroundTruth,
    assertions: [
      // Real-convo assertions are LOOSE — we mainly want to confirm the bot
      // doesn't silently fail or violate hard contract rules. Tight rubric
      // scoring against ground-truth would need an LLM judge layer (future).
      { type: 'bot_must_reply' },
      {
        type: 'must_not_mention',
        keywords: [
          "i'm an ai", 'i am an ai', 'i am a bot', 'im a bot',
          'as an ai', 'i apologize', 'i apologise',
          'circle back', 'touch base',
        ],
      },
    ],
  });
}

const outPath = path.resolve('../loop/regression/scenarios/real-extracted.json');
await fs.writeFile(outPath, JSON.stringify(scenarios, null, 2));

console.log(`wrote ${scenarios.length} scenarios → ${outPath} (skipped ${skipped} unusable)`);
console.log(`length distribution:`);
const buckets = { 'short (2-3)': 0, 'medium (4-7)': 0, 'long (8+)': 0 };
for (const s of scenarios) {
  const n = s.fanMessages.length;
  if (n <= 3) buckets['short (2-3)']++;
  else if (n <= 7) buckets['medium (4-7)']++;
  else buckets['long (8+)']++;
}
console.log(' ', buckets);

await c.end();

function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]+>/g, ' ')         // strip HTML tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
