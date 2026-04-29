// Trigger a real 429 from OnlyFansAPI using a READ-only endpoint
// (no fan-facing side effects) and dump the full response headers so we can
// verify whether they're actually sending the Retry-After header.
//
// Usage:  node _test_real_429.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEnv() {
  const txt = await fs.readFile(path.join(__dirname, '.env.local'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = await loadEnv();
const apiBase = env.PLATFORM_API_BASE;
const apiKey = env.PLATFORM_API_KEY;
// Khlo's OnlyFansAPI account id (production). Read-only operations only.
const acctId =
  (env.PLATFORM_ACCOUNT_ALLOWLIST || '').split(',')[0]?.trim() ||
  'acct_92f627efcaf946009d555c060e92dee6';

if (!apiBase || !apiKey) {
  console.error('Missing PLATFORM_API_BASE / PLATFORM_API_KEY in backend/.env.local');
  process.exit(1);
}

console.log(`Target: ${apiBase}/api/${acctId}/chats?filter=unread`);
console.log(`Strategy: rapid GET bursts until first 429, then dump headers.`);
console.log(`This is a READ — no messages get sent to fans.\n`);

const url = `${apiBase}/api/${acctId}/chats?filter=unread&limit=10`;
const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

let attempt = 0;
const MAX_ATTEMPTS = 60;     // safety cap so we don't spam forever
const BURST_SIZE = 5;        // how many requests to fire before pausing

while (attempt < MAX_ATTEMPTS) {
  // Fire BURST_SIZE requests in parallel to maximize 429 chance.
  const promises = [];
  for (let i = 0; i < BURST_SIZE; i++) {
    promises.push(
      fetch(url, { headers })
        .then((r) => ({ ok: true, status: r.status, headers: r.headers }))
        .catch((e) => ({ ok: false, error: e.message })),
    );
  }
  const results = await Promise.all(promises);

  for (const r of results) {
    attempt++;
    if (!r.ok) {
      console.log(`  attempt ${attempt}: network error — ${r.error}`);
      continue;
    }
    if (r.status === 429) {
      console.log(`\n=== 429 received on attempt ${attempt} ===`);
      console.log(`Status: ${r.status}`);
      console.log(`Response headers:`);
      for (const [k, v] of r.headers.entries()) {
        const highlight = k.toLowerCase() === 'retry-after' ? ' ← RETRY-AFTER' : '';
        console.log(`  ${k}: ${v}${highlight}`);
      }
      const retryAfter = r.headers.get('retry-after');
      if (retryAfter) {
        console.log(`\n✓ OFAPI IS sending Retry-After: "${retryAfter}"`);
      } else {
        console.log(`\n✗ NO Retry-After header in response`);
      }
      process.exit(0);
    }
    console.log(`  attempt ${attempt}: status ${r.status}`);
  }

  // Brief gap between bursts so OFAPI doesn't flat-out reject the connection.
  await new Promise((r) => setTimeout(r, 250));
}

console.log(`\n=== No 429 after ${attempt} attempts ===`);
console.log(`Either the rate limit is well above ${attempt} requests, or OFAPI changed limits since 2026-04-28.`);
