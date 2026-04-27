// One-shot sanity test: inject a fan message, wait for the bot reply.
import fs from 'node:fs/promises';

const env = {};
for (const line of (await fs.readFile('backend/.env.local', 'utf8')).split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const BASE = `http://localhost:${env.ADMIN_PORT || 8787}`;
const TOKEN = env.ADMIN_TOKEN;

async function call(p, init = {}) {
  const r = await fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${p} ${r.status}`);
  return r.json();
}

const fanId = 'sanity-' + Date.now().toString(36);
console.log('inject', fanId);
await call('/admin/test/inject', { method: 'POST', body: JSON.stringify({ subscriberExternalId: fanId, subscriberName: fanId, text: "hey just subbed, you're cute" }) });

let convId = null;
for (let i = 0; i < 20 && !convId; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const { threads } = await call('/admin/threads');
  convId = threads.find((t) => t.subscriberExternalId === fanId)?.conversationId ?? null;
}
console.log('conv', convId);

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const detail = await call(`/admin/threads/${convId}`);
  const outbound = (detail.messages || []).filter((m) => m.direction === 'outbound');
  if (outbound.length) {
    console.log(`REPLY at ${i + 1}s:`, outbound.map((m) => m.text).join(' | '));
    process.exit(0);
  }
}
console.log('NO REPLY in 60s');
process.exit(1);
