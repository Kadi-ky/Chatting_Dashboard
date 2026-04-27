// READ-ONLY damage assessment for test data pollution.
// Counts rows attributable to loop test runs across all affected tables.
// Does NOT delete or modify anything.
import fs from 'node:fs/promises';
import pg from 'pg';

const txt = await fs.readFile('backend/.env.local', 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

const TEST_PATTERN = `(external_id LIKE 'loop-%' OR external_id LIKE 'sanity-%' OR external_id = 'test-fan-001' OR external_id LIKE 'test-fan-%')`;

async function q(label, sql, params = []) {
  try {
    const r = await client.query(sql, params);
    console.log(`${label}: ${JSON.stringify(r.rows)}`);
  } catch (e) {
    console.log(`${label}: ERROR ${e.message}`);
  }
}

console.log('\n=== TEST DATA INVENTORY (READ-ONLY) ===\n');

await q(
  'test subscribers',
  `SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM v3.subscribers WHERE ${TEST_PATTERN}`,
);

await q(
  'test conversations',
  `SELECT COUNT(*) AS n FROM v3.conversations c JOIN v3.subscribers s ON s.id = c.subscriber_id WHERE ${TEST_PATTERN.replace(/external_id/g, 's.external_id')}`,
);

await q(
  'test ppv_attempts (all outcomes)',
  `SELECT outcome, COUNT(*) AS n, SUM(price_cents) AS sum_cents
   FROM v3.ppv_attempts a
   JOIN v3.conversations c ON c.id = a.conversation_id
   JOIN v3.subscribers s ON s.id = c.subscriber_id
   WHERE ${TEST_PATTERN.replace(/external_id/g, 's.external_id')}
   GROUP BY outcome`,
);

await q(
  'test transactions (fake revenue)',
  `SELECT kind, COUNT(*) AS n, SUM(amount_cents) AS sum_cents
   FROM v3.transactions t
   JOIN v3.subscribers s ON s.id = t.subscriber_id
   WHERE ${TEST_PATTERN.replace(/external_id/g, 's.external_id')}
   GROUP BY kind`,
);

// purchases_onlyfans uses fan_uuid which is the test external_id we set.
await q(
  'test purchases_onlyfans',
  `SELECT COUNT(*) AS n, SUM(amount_cents) AS sum_cents
   FROM purchases_onlyfans
   WHERE fan_uuid LIKE 'loop-%' OR fan_uuid LIKE 'sanity-%' OR fan_uuid LIKE 'test-fan-%'`,
);

// Catalog counters polluted: count ppv_catalog rows where attempts came from test fans.
await q(
  'catalog rows touched by tests + how much fake activity',
  `SELECT cat.id, cat.title, COUNT(a.id) AS test_attempts,
          COUNT(*) FILTER (WHERE a.outcome = 'unlocked') AS test_unlocks,
          COALESCE(SUM(a.price_cents) FILTER (WHERE a.outcome = 'unlocked'), 0) AS fake_revenue_cents
   FROM v3.ppv_catalog cat
   JOIN v3.ppv_attempts a ON a.asset_id = cat.id
   JOIN v3.conversations c ON c.id = a.conversation_id
   JOIN v3.subscribers s ON s.id = c.subscriber_id
   WHERE ${TEST_PATTERN.replace(/external_id/g, 's.external_id')}
   GROUP BY cat.id, cat.title
   ORDER BY test_attempts DESC`,
);

await q(
  'subscribers.total_spend_cents pollution (sum across test fans)',
  `SELECT COUNT(*) AS test_subs_with_spend, SUM(total_spend_cents) AS fake_spend_cents
   FROM v3.subscribers WHERE ${TEST_PATTERN} AND total_spend_cents > 0`,
);

await client.end();
console.log('\n=== END (no writes performed) ===');
