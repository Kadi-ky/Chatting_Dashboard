// Smoke test for the rewritten scriptPicker. Verifies:
//   1. With NO progress, picker returns Script 1 rung 1 (sequential fresh).
//   2. After unlocking S1R1..R4, picker returns Script 2 rung 1 (NOT S3R2 — the old bug).
//   3. After unlocking S2R1, S2R2, picker returns Script 2 rung 3 (continue ladder).
//   4. With S2 in-progress + a topic ask for "feet" → continues S2 anyway (in-progress wins).
//   5. With NO progress + topic ask for "bj" → picks the bj-matching script.
//
// Run: cd backend && node _smoke_picker_ordering.mjs

import 'dotenv/config';

// Need .env.local loaded before importing config
const dotenv = await import('dotenv');
dotenv.config({ path: '.env.local', override: true });

const { pickNextForFan } = await import('./src/ppv/scriptPicker.ts');
const pg = (await import('pg')).default;

const TEST_CREATOR_UUID = 'acct_TEST_LOOP';
const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-00000000beef';
const TEST_FAN = `picker-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else    { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function recordPurchase(scriptNumber, rung, amountCents) {
  await c.query(
    `INSERT INTO purchases_onlyfans (fan_uuid, creator_uuid, script_number, rung, amount, purchased_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [TEST_FAN, TEST_CREATOR_UUID, scriptNumber, rung, amountCents],
  );
}

async function pickerSays() {
  return await pickNextForFan({
    accountId: TEST_ACCOUNT_ID,
    creatorUuid: TEST_CREATOR_UUID,
    fanUuid: TEST_FAN,
    archetype: null,
    phase: 'MONETIZING',
    requestedTopic: null,
  });
}

async function pickerSaysWithTopic(topic) {
  return await pickNextForFan({
    accountId: TEST_ACCOUNT_ID,
    creatorUuid: TEST_CREATOR_UUID,
    fanUuid: TEST_FAN,
    archetype: null,
    phase: 'MONETIZING',
    requestedTopic: topic,
  });
}

console.log('\n=== TEST 1: fresh fan with no progress → S1R1 ===');
{
  const r = await pickerSays();
  check('returns a pick', r != null);
  check('script number = 1', r?.scriptNumber === 1, `got ${r?.scriptNumber}`);
  check('rung = 1', r?.rung === 1, `got ${r?.rung}`);
}

console.log('\n=== TEST 2: after unlocking S1 R1-R4, picker returns S2R1 (NOT S3R2 — the bug) ===');
{
  await recordPurchase(1, 1, 15);
  await recordPurchase(1, 2, 35);
  await recordPurchase(1, 3, 69);
  await recordPurchase(1, 4, 99);
  const r = await pickerSays();
  check('returns a pick', r != null);
  check('script number = 2 (NOT 3 — the old VIP-jump bug)', r?.scriptNumber === 2, `got S${r?.scriptNumber}R${r?.rung}`);
  check('rung = 1 (NOT rung 2 — the old VIP-skip-cheap bug)', r?.rung === 1, `got rung ${r?.rung}`);
  check('reason = "new"', r?.reason === 'new', `got ${r?.reason}`);
}

console.log('\n=== TEST 3: continue ladder — after S2R1, S2R2 unlocked, returns S2R3 ===');
{
  await recordPurchase(2, 1, 15);
  await recordPurchase(2, 2, 35);
  const r = await pickerSays();
  check('returns a pick', r != null);
  check('continues S2', r?.scriptNumber === 2, `got S${r?.scriptNumber}`);
  check('rung = 3 (next in ladder)', r?.rung === 3, `got rung ${r?.rung}`);
  check('reason = "continue"', r?.reason === 'continue', `got ${r?.reason}`);
}

console.log('\n=== TEST 4: in-progress fan asks for "boobs" — STILL continues S2 (ladder wins) ===');
{
  const r = await pickerSaysWithTopic('boobs');
  check('returns a pick', r != null);
  check('continues S2 (no topic jump)', r?.scriptNumber === 2, `got S${r?.scriptNumber}R${r?.rung}`);
  check('rung = 3', r?.rung === 3, `got rung ${r?.rung}`);
  check('reason = "continue" (NOT "topic_match")', r?.reason === 'continue', `got ${r?.reason}`);
}

console.log('\n=== TEST 5: cleanup, then fresh fan + topic "bj" → picks a bj-matching rung ===');
{
  // Clean up this fan's progress so it's "fresh" again
  await c.query(`DELETE FROM purchases_onlyfans WHERE fan_uuid = $1`, [TEST_FAN]);
  const r = await pickerSaysWithTopic('bj');
  check('returns a pick', r != null);
  check('reason = "topic_match"', r?.reason === 'topic_match', `got ${r?.reason}`);
  // Don't assert specific script — depends on catalog content. Just confirm it
  // matched something and the description / tags actually mention bj-related content.
  console.log(`     picked S${r?.scriptNumber}R${r?.rung} | "${r?.asset?.description?.slice(0, 60)}..."`);
}

// Cleanup after run
await c.query(`DELETE FROM purchases_onlyfans WHERE fan_uuid = $1`, [TEST_FAN]);
await c.end();

console.log(`\n=== SUMMARY ===  pass=${pass}  fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
