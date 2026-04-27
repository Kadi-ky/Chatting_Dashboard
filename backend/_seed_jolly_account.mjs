// Seed a SECOND test account, distinct from the Peach test account, that
// resolves to the "jolly" persona via the personas/<accountId>/identity.md
// lookup. We mirror personas/jolly/identity.md into personas/<this-uuid>/
// so the existing loadIdentityLayer code finds it without modification.
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const TEST_ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const TEST_CREATOR_UUID = 'acct_TEST_LOOP_JOLLY';

const txt = await fs.readFile('.env.local', 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();

const r = await c.query(
  `INSERT INTO v3.accounts (id, name, persona_version, status, config, platform, creator_uuid)
   VALUES ($1, 'Jolly Test Account', 'default', 'active', '{}'::jsonb, 'onlyfans', $2)
   ON CONFLICT (id) DO UPDATE SET updated_at = now()
   RETURNING id, name, creator_uuid`,
  [TEST_ACCOUNT_ID, TEST_CREATOR_UUID],
);
console.log('jolly test account:', r.rows[0]);

// Mirror personas/jolly/identity.md into personas/<TEST_ACCOUNT_ID>/identity.md
const personasRoot = path.resolve('personas');
const dest = path.join(personasRoot, TEST_ACCOUNT_ID);
await fs.mkdir(dest, { recursive: true });
const src = path.join(personasRoot, 'jolly', 'identity.md');
await fs.copyFile(src, path.join(dest, 'identity.md'));
console.log(`copied persona: ${src} → ${dest}/identity.md`);

// Mirror catalog scripts under acct_TEST_LOOP_JOLLY too so the picker has things to pitch.
const REAL_CREATOR_UUID = 'acct_5d32685ee72144e9a1fc1ce9bde8edc6';
await c.query('BEGIN');
try {
  await c.query(`DELETE FROM public.content_inventory_onlyfans WHERE creator_uuid = $1`, [TEST_CREATOR_UUID]);
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='content_inventory_onlyfans' AND column_name <> 'id'
     ORDER BY ordinal_position`,
  );
  const columnNames = cols.rows.map((r) => r.column_name);
  const selectExprs = columnNames.map((c) => {
    if (c === 'creator_uuid') return `'${TEST_CREATOR_UUID}'`;
    if (c === 'creator_name') return `'JollyTest'`;
    return `"${c}"`;
  });
  const insertSql = `
    INSERT INTO public.content_inventory_onlyfans (${columnNames.map((c) => `"${c}"`).join(', ')})
    SELECT ${selectExprs.join(', ')}
    FROM public.content_inventory_onlyfans
    WHERE creator_uuid = $1
  `;
  const ins = await c.query(insertSql, [REAL_CREATOR_UUID]);
  await c.query('COMMIT');
  console.log(`mirrored ${ins.rowCount} scripts under jolly creator`);
} catch (e) {
  await c.query('ROLLBACK');
  console.error('catalog seed rollback:', e.message);
  process.exitCode = 1;
}

await c.end();
console.log(`\n✅ jolly persona ready. ACCOUNT_ID=${TEST_ACCOUNT_ID}`);
