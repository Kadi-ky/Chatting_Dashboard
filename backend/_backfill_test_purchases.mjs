// One-shot backfill: for every v3.ppv_attempts row with outcome='unlocked'
// on the test account, insert a matching purchases_onlyfans row if one
// doesn't already exist. Unsticks conversations that unlocked under the
// earlier (overly aggressive) isTest filter.
import fs from 'node:fs/promises';
import pg from 'pg';

const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-00000000beef';

const txt = await fs.readFile('.env.local', 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();

// Find every unlocked attempt in the test account + parse the legacy source_ref
// (of:<creatorUuid>:<scriptNumber>:<rung>) to know what purchase row to insert.
const unlocks = await c.query(
  `SELECT a.id AS attempt_id, a.price_cents, a.unlocked_at, a.asset_id,
          s.external_id AS fan_uuid, cat.source_ref
   FROM v3.ppv_attempts a
   JOIN v3.conversations conv ON conv.id = a.conversation_id
   JOIN v3.subscribers s ON s.id = conv.subscriber_id
   JOIN v3.ppv_catalog cat ON cat.id = a.asset_id
   WHERE a.outcome = 'unlocked' AND conv.account_id = $1`,
  [TEST_ACCOUNT_ID],
);

let backfilled = 0, alreadyHad = 0, skipped = 0;
for (const row of unlocks.rows) {
  const match = /^of:([^:]+):(\d+):(\d+)$/.exec(row.source_ref ?? '');
  if (!match) { skipped++; continue; }
  const [, creatorUuid, scriptNumber, rung] = match;

  const existing = await c.query(
    `SELECT 1 FROM purchases_onlyfans
     WHERE fan_uuid = $1 AND creator_uuid = $2 AND script_number = $3 AND rung = $4`,
    [row.fan_uuid, creatorUuid, scriptNumber, rung],
  );
  if (existing.rows.length > 0) { alreadyHad++; continue; }

  await c.query(
    `INSERT INTO purchases_onlyfans (fan_uuid, creator_uuid, script_number, rung, amount, purchased_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.fan_uuid, creatorUuid, Number(scriptNumber), Number(rung), row.price_cents, row.unlocked_at ?? new Date()],
  );
  backfilled++;
}

console.log(`checked ${unlocks.rows.length} test unlocks → backfilled ${backfilled} new purchase rows (${alreadyHad} already had, ${skipped} non-legacy)`);
await c.end();
