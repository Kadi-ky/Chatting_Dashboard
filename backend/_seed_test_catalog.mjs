// Mirror the production content_inventory rows into the TEST creator_uuid so
// the script picker has scripts to pitch when the loop runs.
// Idempotent (DELETE then INSERT under acct_TEST_LOOP).
import fs from 'node:fs/promises';
import pg from 'pg';

const TEST_CREATOR_UUID = 'acct_TEST_LOOP';
const REAL_CREATOR_UUID = 'acct_5d32685ee72144e9a1fc1ce9bde8edc6';

const txt = await fs.readFile('.env.local', 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();

await c.query('BEGIN');
try {
  // Clear any prior test catalog so this is a clean re-seed.
  const del = await c.query(
    `DELETE FROM public.content_inventory_onlyfans WHERE creator_uuid = $1`,
    [TEST_CREATOR_UUID],
  );
  console.log(`cleared ${del.rowCount} existing test scripts`);

  // Copy every column from prod scripts, swapping creator_uuid + creator_name
  // and prefixing script_name to make test scripts visually distinct.
  // id is omitted so postgres assigns a fresh one.
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='content_inventory_onlyfans' AND column_name <> 'id'
     ORDER BY ordinal_position`,
  );
  const columnNames = cols.rows.map((r) => r.column_name);
  console.log(`columns to copy: ${columnNames.length}`);

  // Build dynamic INSERT ... SELECT swapping creator_uuid/creator_name.
  const selectExprs = columnNames.map((c) => {
    if (c === 'creator_uuid') return `'${TEST_CREATOR_UUID}'`;
    if (c === 'creator_name') return `'TestLoop'`;
    return `"${c}"`;
  });
  const insertSql = `
    INSERT INTO public.content_inventory_onlyfans (${columnNames.map((c) => `"${c}"`).join(', ')})
    SELECT ${selectExprs.join(', ')}
    FROM public.content_inventory_onlyfans
    WHERE creator_uuid = $1
  `;
  const ins = await c.query(insertSql, [REAL_CREATOR_UUID]);
  console.log(`inserted ${ins.rowCount} test scripts`);

  // Show what we now have.
  const verify = await c.query(
    `SELECT script_number, script_name FROM public.content_inventory_onlyfans
     WHERE creator_uuid = $1 ORDER BY script_number`,
    [TEST_CREATOR_UUID],
  );
  console.log('test scripts now:');
  for (const r of verify.rows) console.log(`  #${r.script_number}: ${r.script_name}`);

  await c.query('COMMIT');
  console.log('\n✅ test catalog seeded');
} catch (e) {
  await c.query('ROLLBACK');
  console.error('ROLLBACK:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
