// Seed a dedicated test account so loop runs are isolated from real prod data.
// Idempotent — re-runnable. Prints the account_id to add to loop env.
import fs from 'node:fs/promises';
import pg from 'pg';

const txt = await fs.readFile('.env.local', 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

// Stable UUID so re-running the seed is idempotent and the orchestrator
// can hard-code this id without round-tripping a query.
const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-00000000beef';
const TEST_CREATOR_UUID = 'acct_TEST_LOOP';

const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();

const r = await c.query(
  `INSERT INTO v3.accounts (id, name, persona_version, status, config, platform, creator_uuid)
   VALUES ($1, 'Test Loop Account', 'default', 'active', '{}'::jsonb, 'onlyfans', $2)
   ON CONFLICT (id) DO UPDATE SET updated_at = now()
   RETURNING id, name, creator_uuid`,
  [TEST_ACCOUNT_ID, TEST_CREATOR_UUID],
);
console.log('test account ready:', r.rows[0]);
console.log(`\nTEST_ACCOUNT_ID=${TEST_ACCOUNT_ID}`);
console.log(`TEST_CREATOR_UUID=${TEST_CREATOR_UUID}`);

await c.end();
