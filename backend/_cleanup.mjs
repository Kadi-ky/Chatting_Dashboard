// Cleanup of test-data pollution. Runs as a transaction.
//   node _cleanup.mjs            → DRY RUN (rolls back at the end, prints what would change)
//   node _cleanup.mjs --commit   → COMMITS the cleanup. Destructive. Use only after dry-run review.
//
// Order matters:
//   1. Compute per-asset deltas while ppv_attempts still exist (read).
//   2. Decrement ppv_catalog counters (writes).
//   3. Decrement asset_performance counters per (asset_id, archetype_slice jsonb).
//      Slice = {spenderTier, priceSensitivity} matching what archetypeSlice() returns.
//      For test fans without a classified archetype, default slice is
//      {spenderTier: "never", priceSensitivity: "mid"} per ranker.ts:81-84.
//   4. Delete purchases_onlyfans test rows (no FK).
//   5. Delete v3.subscribers test rows — CASCADE removes conversations, ppv_attempts,
//      transactions, archetypes, messages, state_transitions, subscriber_facts.

import fs from 'node:fs/promises';
import pg from 'pg';

const COMMIT = process.argv.includes('--commit');

const txt = await fs.readFile('.env.local', 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const TEST_PATTERN = `(s.external_id LIKE 'loop-%' OR s.external_id LIKE 'sanity-%' OR s.external_id LIKE 'test-fan-%')`;
const TEST_PURCHASE_PATTERN = `(fan_uuid LIKE 'loop-%' OR fan_uuid LIKE 'sanity-%' OR fan_uuid LIKE 'test-fan-%')`;

const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();

console.log(`\n=== ${COMMIT ? 'COMMIT MODE' : 'DRY RUN MODE'} (use --commit to apply) ===\n`);

await c.query('BEGIN');
try {
  // 1. Catalog deltas (per asset).
  const catalogDeltas = await c.query(
    `SELECT a.asset_id,
            COUNT(*) AS total_attempts,
            COUNT(*) FILTER (WHERE a.outcome = 'unlocked') AS unlocks,
            COALESCE(SUM(a.price_cents) FILTER (WHERE a.outcome = 'unlocked'), 0)::bigint AS revenue_cents
     FROM v3.ppv_attempts a
     JOIN v3.conversations conv ON conv.id = a.conversation_id
     JOIN v3.subscribers s ON s.id = conv.subscriber_id
     WHERE ${TEST_PATTERN}
     GROUP BY a.asset_id`,
  );
  console.log('catalog deltas to apply:');
  for (const r of catalogDeltas.rows) {
    console.log(`  asset=${r.asset_id}  -attempts=${r.total_attempts}  -unlocks=${r.unlocks}  -revenue_cents=${r.revenue_cents}`);
  }

  // 2. asset_performance deltas: group by (asset_id, slice) where slice mirrors
  // archetypeSlice() output. Subscribers with no classified archetype default
  // to {spenderTier:"never", priceSensitivity:"mid"}.
  const perfDeltas = await c.query(
    `SELECT a.asset_id,
            jsonb_build_object(
              'spenderTier',     COALESCE(arch.spender_tier::text, 'never'),
              'priceSensitivity', COALESCE(arch.price_sensitivity::text, 'mid')
            ) AS slice,
            COUNT(*) AS attempts,
            COUNT(*) FILTER (WHERE a.outcome = 'unlocked') AS unlocks,
            COALESCE(SUM(a.price_cents) FILTER (WHERE a.outcome = 'unlocked'), 0)::bigint AS revenue_cents
     FROM v3.ppv_attempts a
     JOIN v3.conversations conv ON conv.id = a.conversation_id
     JOIN v3.subscribers s ON s.id = conv.subscriber_id
     LEFT JOIN LATERAL (
       SELECT spender_tier, price_sensitivity FROM v3.archetypes ar
       WHERE ar.subscriber_id = s.id
       ORDER BY ar.classified_at DESC LIMIT 1
     ) arch ON true
     WHERE ${TEST_PATTERN}
     GROUP BY a.asset_id, slice`,
  );
  console.log(`\nasset_performance slices to decrement: ${perfDeltas.rows.length} rows`);

  // 3. Apply ppv_catalog decrements (clamp at 0).
  for (const r of catalogDeltas.rows) {
    await c.query(
      `UPDATE v3.ppv_catalog
       SET attempts_count = GREATEST(0, attempts_count - $1::bigint),
           unlocks_count  = GREATEST(0, unlocks_count  - $2::bigint),
           revenue_cents  = GREATEST(0, revenue_cents  - $3::bigint)
       WHERE id = $4`,
      [Number(r.total_attempts), Number(r.unlocks), Number(r.revenue_cents), r.asset_id],
    );
  }

  // 4. Apply asset_performance decrements (clamp at 0).
  let perfUpdated = 0;
  for (const r of perfDeltas.rows) {
    const u = await c.query(
      `UPDATE v3.asset_performance
       SET attempts      = GREATEST(0, attempts      - $1::bigint),
           unlocks       = GREATEST(0, unlocks       - $2::bigint),
           revenue_cents = GREATEST(0, revenue_cents - $3::bigint),
           updated_at    = now()
       WHERE asset_id = $4 AND archetype_slice = $5::jsonb`,
      [
        Number(r.attempts),
        Number(r.unlocks),
        Number(r.revenue_cents),
        r.asset_id,
        JSON.stringify(r.slice),
      ],
    );
    perfUpdated += u.rowCount ?? 0;
  }
  console.log(`asset_performance UPDATEs that matched: ${perfUpdated} / ${perfDeltas.rows.length}`);

  // 5. Delete legacy purchases_onlyfans rows.
  const delPurchases = await c.query(
    `DELETE FROM purchases_onlyfans WHERE ${TEST_PURCHASE_PATTERN}`,
  );
  console.log(`purchases_onlyfans deleted: ${delPurchases.rowCount}`);

  // 6. Delete test subscribers — CASCADE handles the rest.
  const delSubs = await c.query(
    `DELETE FROM v3.subscribers s WHERE ${TEST_PATTERN}`,
  );
  console.log(`v3.subscribers deleted (CASCADE removes children): ${delSubs.rowCount}`);

  // Verification — should all return 0 after this transaction.
  const verify = await c.query(
    `SELECT
       (SELECT COUNT(*) FROM v3.subscribers s WHERE ${TEST_PATTERN}) AS subs_left,
       (SELECT COUNT(*) FROM purchases_onlyfans WHERE ${TEST_PURCHASE_PATTERN}) AS purchases_left,
       (SELECT COUNT(*) FROM v3.transactions t JOIN v3.subscribers s ON s.id = t.subscriber_id WHERE ${TEST_PATTERN}) AS tx_left,
       (SELECT COUNT(*) FROM v3.ppv_attempts a JOIN v3.conversations conv ON conv.id = a.conversation_id JOIN v3.subscribers s ON s.id = conv.subscriber_id WHERE ${TEST_PATTERN}) AS attempts_left`,
  );
  console.log('\nverification (should all be 0):', verify.rows[0]);

  if (COMMIT) {
    await c.query('COMMIT');
    console.log('\n✅ COMMITTED. Test data removed, counters decremented.');
  } else {
    await c.query('ROLLBACK');
    console.log('\n🔁 ROLLED BACK (dry-run). Re-run with --commit to apply.');
  }
} catch (e) {
  await c.query('ROLLBACK');
  console.error('\nERROR — rolled back:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
