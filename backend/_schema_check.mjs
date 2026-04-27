// READ-ONLY: inspect the purchases_onlyfans table schema so cleanup uses the right columns.
import fs from 'node:fs/promises';
import pg from 'pg';

const txt = await fs.readFile('.env.local', 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();

const r1 = await c.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='purchases_onlyfans' ORDER BY ordinal_position`);
console.log('purchases_onlyfans columns:');
for (const row of r1.rows) console.log(' ', row.column_name, row.data_type);

const r2 = await c.query(`SELECT COUNT(*) AS n FROM purchases_onlyfans WHERE fan_uuid LIKE 'loop-%' OR fan_uuid LIKE 'sanity-%' OR fan_uuid LIKE 'test-fan-%'`);
console.log('\ntest rows in purchases_onlyfans:', r2.rows[0].n);

// Foreign keys we need to handle on cascade for cleanup
const r3 = await c.query(`SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_col, rc.delete_rule
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
  JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'v3'
    AND ccu.table_name IN ('subscribers','conversations','ppv_attempts','transactions')
  ORDER BY tc.table_name`);
console.log('\nFKs pointing to the tables we are about to delete from:');
for (const row of r3.rows) console.log(`  ${row.table_name}.${row.column_name} -> v3.${row.ref_table}.${row.ref_col}  on_delete=${row.delete_rule}`);

await c.end();
