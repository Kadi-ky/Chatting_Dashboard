// Verify both isolation layers work end-to-end:
//   - Inject a test message via /admin/test/inject (with TEST_ACCOUNT_ID override)
//   - Wait for the bot to reply (and pitch a PPV)
//   - Trigger /admin/test/ppv-unlock to "buy" the PPV
//   - Confirm:
//     * conversation/subscriber landed under TEST_ACCOUNT_ID (not real account)
//     * v3.transactions has NO new row for this fan (Layer 1 isTest filter)
//     * v3.ppv_catalog counters did NOT change for the asset
//     * purchases_onlyfans has NO new row for this fan
//     * The ppv_attempts row IS marked unlocked (so the test conv flow continues)
import fs from 'node:fs/promises';
import pg from 'pg';

const txt = await fs.readFile('.env.local', 'utf8');
const env = {};
for (const line of txt.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const BASE = `http://localhost:${env.ADMIN_PORT || 8787}`;
const TOKEN = env.ADMIN_TOKEN;
const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-00000000beef';
const REAL_ACCOUNT_ID = env.ACCOUNT_ID;

async function call(p, init = {}) {
  const r = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`${p} ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();

// Snapshot ppv_catalog counters BEFORE — Script 1 rung 1 is the most-pitched asset.
const before = await c.query(
  `SELECT id, attempts_count, unlocks_count, revenue_cents FROM v3.ppv_catalog WHERE id = 'ca306a72-fdfc-45f6-aa77-642edeeb22de'`,
);
console.log('catalog BEFORE:', before.rows[0]);

const fanId = 'verify-iso-' + Date.now().toString(36);
console.log('\n1. injecting test fan:', fanId, '(should land in test account)');
const inj = await call('/admin/test/inject', {
  method: 'POST',
  body: JSON.stringify({ subscriberExternalId: fanId, subscriberName: fanId, text: 'hey gimme a pic now', accountId: TEST_ACCOUNT_ID }),
});
console.log('   →', inj);

// Wait for conversation
let convId = null;
for (let i = 0; i < 20 && !convId; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const t = await call('/admin/threads');
  const found = t.threads.find((x) => x.subscriberExternalId === fanId);
  if (found) convId = found.conversationId;
}
console.log('   conversation:', convId);

// Verify the conversation belongs to the TEST account, not real.
const convRow = await c.query(
  `SELECT account_id FROM v3.conversations WHERE id = $1`,
  [convId],
);
const convAccount = convRow.rows[0]?.account_id;
console.log(`   conversation.account_id = ${convAccount}`);
console.log(`   ${convAccount === TEST_ACCOUNT_ID ? '✅' : '❌'} matches TEST_ACCOUNT_ID? ${convAccount === TEST_ACCOUNT_ID}`);
console.log(`   ${convAccount !== REAL_ACCOUNT_ID ? '✅' : '❌'} differs from REAL_ACCOUNT_ID? ${convAccount !== REAL_ACCOUNT_ID}`);

// Wait for bot reply (with possible PPV).
console.log('\n2. waiting for bot reply...');
let ppvMessageId = null;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const detail = await call(`/admin/threads/${convId}`);
  const ppv = (detail.messages || []).find((m) => m.kind === 'ppv' && m.direction === 'outbound');
  if (ppv) {
    ppvMessageId = ppv.id;
    console.log(`   bot pitched PPV at ${i + 1}s: ${ppv.text?.slice(0, 80)}`);
    break;
  }
}

if (!ppvMessageId) {
  console.log('   no PPV pitched in 90s — skipping unlock step. (Layer 2 still verified above.)');
} else {
  console.log('\n3. simulating fan PPV unlock (should NOT touch real-account analytics)');
  await call('/admin/test/ppv-unlock', {
    method: 'POST',
    body: JSON.stringify({ conversationId: convId, messageId: ppvMessageId }),
  });
  await new Promise((r) => setTimeout(r, 2500)); // let unlock pipeline run
}

// Final verification queries.
console.log('\n4. verification queries:');

const after = await c.query(
  `SELECT id, attempts_count, unlocks_count, revenue_cents FROM v3.ppv_catalog WHERE id = 'ca306a72-fdfc-45f6-aa77-642edeeb22de'`,
);
console.log('   catalog AFTER:', after.rows[0]);
const catalogChanged =
  Number(after.rows[0].unlocks_count) !== Number(before.rows[0].unlocks_count) ||
  Number(after.rows[0].revenue_cents) !== Number(before.rows[0].revenue_cents);
// attempts_count CAN go up (tracked at pitch time, not unlock — and that's pre-isTest gate). But unlocks/revenue must stay flat.
console.log(`   ${!catalogChanged ? '✅' : '❌'} ppv_catalog unlocks/revenue unchanged? ${!catalogChanged}`);
const attemptsDelta = Number(after.rows[0].attempts_count) - Number(before.rows[0].attempts_count);
console.log(`   note: attempts_count delta = ${attemptsDelta} (this still increments at pitch — separate fix needed if you want this isolated too)`);

const tx = await c.query(
  `SELECT COUNT(*) AS n FROM v3.transactions t JOIN v3.subscribers s ON s.id = t.subscriber_id WHERE s.external_id = $1`,
  [fanId],
);
console.log(`   ${Number(tx.rows[0].n) === 0 ? '✅' : '❌'} v3.transactions for this fan: ${tx.rows[0].n} (should be 0)`);

const purch = await c.query(
  `SELECT COUNT(*) AS n FROM purchases_onlyfans WHERE fan_uuid = $1`,
  [fanId],
);
console.log(`   ${Number(purch.rows[0].n) === 0 ? '✅' : '❌'} purchases_onlyfans for this fan: ${purch.rows[0].n} (should be 0)`);

// Confirm the attempt IS marked unlocked (so the conversation flow itself works).
if (ppvMessageId) {
  const attempt = await c.query(
    `SELECT outcome FROM v3.ppv_attempts WHERE message_id = $1`,
    [ppvMessageId],
  );
  console.log(`   ${attempt.rows[0]?.outcome === 'unlocked' ? '✅' : '❌'} ppv_attempts.outcome = ${attempt.rows[0]?.outcome} (should be 'unlocked' so test flow works)`);
}

await c.end();
