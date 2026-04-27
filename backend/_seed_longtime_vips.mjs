// Seed 3 longtime VIP fans with persistent purchase history.
//
// Each fan is created under TEST_ACCOUNT_ID with a stable external_id like
// "longtime-longtime_vip-set1" matching what loop/orchestrator.mjs expects.
// They get:
//   - A subscriber row
//   - A conversation row in MONETIZING phase (whale-tier)
//   - A few prior outbound/inbound messages (so turnIndex starts high — the
//     rapport gate is naturally satisfied)
//   - Pre-seeded purchases_onlyfans rows for Script 1 rungs 1-3 + Script 2 rung 1
//     (so the script picker sees them as mid-ladder, won't restart from rung 1)
//
// Idempotent — re-runnable. Cleanup pattern in _cleanup.mjs uses 'loop-%' /
// 'sanity-%' / 'test-fan-%' prefixes, so 'longtime-' fans are NOT cleaned up.
// Manual deletion via this script's --reset flag if needed.
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const RESET = process.argv.includes('--reset');

const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-00000000beef';
const TEST_CREATOR_UUID = 'acct_TEST_LOOP';

const txt = await fs.readFile('.env.local', 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();

const FANS = [
  {
    externalId: 'longtime-longtime_vip-set1',
    displayName: 'Marcus',
    backstoryMessages: [
      // Inbound, then outbound, alternating — gives the conv prior history.
      ['inbound', 'hey peach long time'],
      ['outbound', 'aw marcus, missed u'],
      ['inbound', 'how was the weekend'],
      ['outbound', 'lowkey wild, biscuit knocked over my coffee twice. how was urs'],
      ['inbound', 'haha that cat is a menace. my weekend was chill, watched the game'],
      ['outbound', 'mmm always with the games, who u rootin for these days'],
    ],
    // Past purchases — script_number, rung, amount_cents, days_ago
    purchases: [
      { scriptNumber: 1, rung: 1, amountCents: 15, daysAgo: 45 },
      { scriptNumber: 1, rung: 2, amountCents: 35, daysAgo: 35 },
      { scriptNumber: 1, rung: 3, amountCents: 69, daysAgo: 20 },
      { scriptNumber: 2, rung: 1, amountCents: 30, daysAgo: 10 },
    ],
  },
  {
    externalId: 'longtime-longtime_vip-set2',
    displayName: 'Tyler',
    backstoryMessages: [
      ['inbound', 'hey'],
      ['outbound', 'tyler, hey babe'],
      ['inbound', 'just got home from a shitty work day'],
      ['outbound', 'aw boo. that finance gig still grinding u down?'],
      ['inbound', 'yeah man same shit different day'],
      ['outbound', 'lowkey relatable. lemme know if u need a distraction'],
    ],
    purchases: [
      { scriptNumber: 1, rung: 1, amountCents: 15, daysAgo: 60 },
      { scriptNumber: 1, rung: 2, amountCents: 35, daysAgo: 50 },
      { scriptNumber: 2, rung: 1, amountCents: 30, daysAgo: 25 },
      { scriptNumber: 2, rung: 2, amountCents: 50, daysAgo: 12 },
    ],
  },
  {
    externalId: 'longtime-longtime_vip-set3',
    displayName: 'Devin',
    backstoryMessages: [
      ['inbound', 'sup beautiful'],
      ['outbound', 'mmm devin, where u been'],
      ['inbound', 'crazy week, finally back'],
      ['outbound', 'figured. saw the dolphins win lol u must be hyped'],
      ['inbound', 'finally a good sunday, u remember'],
      ['outbound', 'course i remember, i listen u know'],
    ],
    purchases: [
      { scriptNumber: 1, rung: 1, amountCents: 15, daysAgo: 90 },
      { scriptNumber: 1, rung: 2, amountCents: 35, daysAgo: 75 },
      { scriptNumber: 1, rung: 3, amountCents: 69, daysAgo: 50 },
      { scriptNumber: 1, rung: 4, amountCents: 99, daysAgo: 30 },
      { scriptNumber: 2, rung: 1, amountCents: 30, daysAgo: 15 },
    ],
  },
];

if (RESET) {
  console.log('--reset: deleting existing longtime VIP fans + their purchases');
  for (const fan of FANS) {
    await c.query(`DELETE FROM v3.subscribers WHERE external_id = $1`, [fan.externalId]);
    await c.query(`DELETE FROM purchases_onlyfans WHERE fan_uuid = $1`, [fan.externalId]);
  }
  console.log('reset done. exiting (re-run without --reset to seed fresh).');
  await c.end();
  process.exit(0);
}

for (const fan of FANS) {
  await c.query('BEGIN');
  try {
    // Skip if subscriber already exists — idempotency.
    const existing = await c.query(
      `SELECT id FROM v3.subscribers WHERE external_id = $1`,
      [fan.externalId],
    );
    if (existing.rows.length > 0) {
      console.log(`✓ ${fan.externalId} already exists, skipping`);
      await c.query('COMMIT');
      continue;
    }

    // 1. Create subscriber.
    const subRow = await c.query(
      `INSERT INTO v3.subscribers (account_id, external_id, display_name, total_spend_cents, spend_30d_cents)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        TEST_ACCOUNT_ID,
        fan.externalId,
        fan.displayName,
        fan.purchases.reduce((acc, p) => acc + p.amountCents, 0),
        fan.purchases.filter((p) => p.daysAgo <= 30).reduce((acc, p) => acc + p.amountCents, 0),
      ],
    );
    const subscriberId = subRow.rows[0].id;

    // 2. Create conversation in MONETIZING phase.
    const convRow = await c.query(
      `INSERT INTO v3.conversations (account_id, subscriber_id, phase, substate, turns_in_phase)
       VALUES ($1, $2, 'MONETIZING', NULL, 6)
       RETURNING id`,
      [TEST_ACCOUNT_ID, subscriberId],
    );
    const conversationId = convRow.rows[0].id;

    // 3. Insert backstory messages so the conversation has prior turns.
    for (let i = 0; i < fan.backstoryMessages.length; i++) {
      const [direction, text] = fan.backstoryMessages[i];
      await c.query(
        `INSERT INTO v3.messages (conversation_id, direction, kind, text, created_at, sent_at)
         VALUES ($1, $2, 'text', $3, now() - interval '7 days' + ($4 || ' minutes')::interval, $5)`,
        [conversationId, direction, text, i * 5, direction === 'outbound' ? new Date() : null],
      );
    }

    // 4. Insert legacy purchases_onlyfans rows so script picker sees the ladder progress.
    for (const p of fan.purchases) {
      await c.query(
        `INSERT INTO purchases_onlyfans (fan_uuid, creator_uuid, script_number, rung, amount, purchased_at)
         VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' days')::interval)`,
        [fan.externalId, TEST_CREATOR_UUID, p.scriptNumber, p.rung, p.amountCents, p.daysAgo],
      );
    }

    await c.query('COMMIT');
    const totalSpend = fan.purchases.reduce((acc, p) => acc + p.amountCents, 0);
    console.log(
      `✓ ${fan.externalId} (${fan.displayName}) — convId=${conversationId}, ${fan.backstoryMessages.length} backstory msgs, ${fan.purchases.length} purchases ($${(totalSpend / 100).toFixed(2)} lifetime)`,
    );
  } catch (e) {
    await c.query('ROLLBACK');
    console.error(`✗ ${fan.externalId} ROLLBACK:`, e.message);
    process.exitCode = 1;
  }
}

await c.end();
console.log('\n✅ longtime VIP fans seeded');
