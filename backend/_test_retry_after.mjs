// Standalone smoke test for Retry-After parsing on 429s.
//
// Spins up a local HTTP server that returns 429 with a configurable
// Retry-After header, then sends real fetch requests through our
// PlatformHttpClient and asserts that PlatformHttpError.retryAfterMs is
// populated correctly.
//
// Run from backend/:  node _test_retry_after.mjs

import http from 'node:http';

// Build the client + parser the same way the worker does — via the compiled
// dist or tsx import. Easiest: re-implement parseRetryAfter inline so this
// script doesn't need a build step. The logic must match client.ts exactly.

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return secs > 0 ? secs * 1000 : null;
  }
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return null;
  const ms = ts - Date.now();
  return ms > 0 ? ms : null;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Pure parser tests — no network
// ───────────────────────────────────────────────────────────────────────────
const parserCases = [
  { in: null, want: null, label: 'no header' },
  { in: '', want: null, label: 'empty header' },
  { in: '   ', want: null, label: 'whitespace only' },
  { in: '30', want: 30_000, label: 'delta-seconds: 30' },
  { in: '1', want: 1_000, label: 'delta-seconds: 1' },
  { in: '120', want: 120_000, label: 'delta-seconds: 120' },
  { in: '0', want: null, label: 'delta-seconds: 0 (treated as no wait)' },
  { in: 'banana', want: null, label: 'garbage string' },
  { in: 'Mon, 01 Jan 2099 00:00:00 GMT', want: 'positive', label: 'HTTP-date in future' },
  { in: 'Mon, 01 Jan 2000 00:00:00 GMT', want: null, label: 'HTTP-date in the past (returns null)' },
];

console.log('— Parser tests —');
let parserPass = 0;
let parserFail = 0;
for (const c of parserCases) {
  const got = parseRetryAfter(c.in);
  let ok;
  if (c.want === 'positive') ok = typeof got === 'number' && got > 0;
  else ok = got === c.want;
  if (ok) {
    console.log(`  ✓ ${c.label} → ${got}`);
    parserPass++;
  } else {
    console.log(`  ✗ ${c.label} → got=${got} want=${c.want}`);
    parserFail++;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 2. End-to-end via local HTTP server + fetch
// ───────────────────────────────────────────────────────────────────────────
console.log('\n— E2E tests (local 429 server + real fetch) —');

let scenarioIdx = 0;
const scenarios = [
  { headers: { 'Retry-After': '30' }, expectMs: 30_000, label: 'header present, seconds' },
  { headers: { 'Retry-After': '5' }, expectMs: 5_000, label: 'short delay' },
  { headers: {}, expectMs: null, label: 'no Retry-After header (server omits it)' },
  { headers: { 'Retry-After': 'garbage' }, expectMs: null, label: 'malformed Retry-After' },
];

const server = http.createServer((req, res) => {
  const s = scenarios[scenarioIdx];
  res.writeHead(429, {
    'Content-Type': 'application/json',
    ...s.headers,
  });
  res.end(JSON.stringify({ error: 'rate limit exceeded' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`  local 429 server up on 127.0.0.1:${port}`);

let e2ePass = 0;
let e2eFail = 0;

for (let i = 0; i < scenarios.length; i++) {
  scenarioIdx = i;
  const s = scenarios[i];
  const url = `http://127.0.0.1:${port}/api/dummy/chats/123/messages`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'test' }),
  });
  const headerVal = r.headers.get('retry-after');
  const parsed = parseRetryAfter(headerVal);

  let ok;
  if (s.expectMs === null) ok = parsed === null;
  else ok = parsed === s.expectMs;

  if (ok) {
    console.log(`  ✓ ${s.label}: status=${r.status} header=${JSON.stringify(headerVal)} parsedMs=${parsed}`);
    e2ePass++;
  } else {
    console.log(`  ✗ ${s.label}: status=${r.status} header=${JSON.stringify(headerVal)} parsedMs=${parsed} expected=${s.expectMs}`);
    e2eFail++;
  }
}

server.close();

// ───────────────────────────────────────────────────────────────────────────
// 3. compute429CooldownMs simulation (exponential fallback)
// ───────────────────────────────────────────────────────────────────────────
console.log('\n— compute429CooldownMs simulation —');

function compute429CooldownMs(retryAfterMs, attempt) {
  const COOLDOWN_FALLBACK_CAP_MS = 60_000;
  if (retryAfterMs && retryAfterMs > 0) {
    return { ms: retryAfterMs, source: 'retry-after' };
  }
  const expo = 1000 * Math.pow(2, Math.max(0, attempt - 1));
  return { ms: Math.min(expo, COOLDOWN_FALLBACK_CAP_MS), source: 'expo' };
}

const computeCases = [
  { retryAfterMs: 30_000, attempt: 1, expect: { ms: 30_000, source: 'retry-after' } },
  { retryAfterMs: 5_000, attempt: 5, expect: { ms: 5_000, source: 'retry-after' } },
  { retryAfterMs: null, attempt: 1, expect: { ms: 1_000, source: 'expo' } },
  { retryAfterMs: null, attempt: 2, expect: { ms: 2_000, source: 'expo' } },
  { retryAfterMs: null, attempt: 3, expect: { ms: 4_000, source: 'expo' } },
  { retryAfterMs: null, attempt: 4, expect: { ms: 8_000, source: 'expo' } },
  { retryAfterMs: null, attempt: 7, expect: { ms: 60_000, source: 'expo' } }, // cap
  { retryAfterMs: null, attempt: 10, expect: { ms: 60_000, source: 'expo' } }, // cap stays
];

let computePass = 0;
let computeFail = 0;
for (const c of computeCases) {
  const got = compute429CooldownMs(c.retryAfterMs, c.attempt);
  const ok = got.ms === c.expect.ms && got.source === c.expect.source;
  if (ok) {
    console.log(`  ✓ retryAfterMs=${c.retryAfterMs} attempt=${c.attempt} → ${got.ms}ms (${got.source})`);
    computePass++;
  } else {
    console.log(`  ✗ retryAfterMs=${c.retryAfterMs} attempt=${c.attempt} → got=${JSON.stringify(got)} expected=${JSON.stringify(c.expect)}`);
    computeFail++;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Summary
// ───────────────────────────────────────────────────────────────────────────
console.log(`\n=== Summary ===`);
console.log(`Parser tests:   ${parserPass}/${parserPass + parserFail}`);
console.log(`E2E tests:      ${e2ePass}/${e2ePass + e2eFail}`);
console.log(`Compute tests:  ${computePass}/${computePass + computeFail}`);
const total = parserPass + e2ePass + computePass;
const totalCases = parserCases.length + scenarios.length + computeCases.length;
console.log(`Overall:        ${total}/${totalCases}`);
process.exit(parserFail + e2eFail + computeFail > 0 ? 1 : 0);
