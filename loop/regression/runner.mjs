#!/usr/bin/env node
// PeachBot regression suite — replays canned scenarios deterministically against
// the V3 admin API. Catches "did this edit break a scenario that previously worked?"
// in 2-3 min instead of a 25-min full auto-improve loop.
//
// Each scenario is a JSON file in loop/regression/scenarios/{*.json}. It defines
// the fan messages to send and assertions about what the bot is allowed to do.
//
// Usage:
//   node loop/regression/runner.mjs              # run all scenarios in scenarios/
//   node loop/regression/runner.mjs <pattern>    # run only scenarios matching glob
//
// The runner uses TEST_ACCOUNT_ID so all data lands in the test account and never
// pollutes Home Tab analytics. Output is written to loop/regression/last_report.json
// and printed to stdout.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const REPORT_PATH = path.join(__dirname, 'last_report.json');

const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-00000000beef';
const REPLY_POLL_MS = 1000;
const REPLY_POLL_TIMEOUT_MS = 60000;
const PARALLEL_SCENARIOS = 5; // run N scenarios concurrently

// ---- env --------------------------------------------------------------

const envText = await fs.readFile(path.join(REPO, 'backend/.env.local'), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const ADMIN_BASE = `http://localhost:${env.ADMIN_PORT || 8787}`;
const ADMIN_TOKEN = env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN missing');

// ---- admin api client -------------------------------------------------

async function adminCall(p, init = {}) {
  const r = await fetch(`${ADMIN_BASE}${p}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}`, ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`${p} ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

const api = {
  health: () => fetch(`${ADMIN_BASE}/health`).then((r) => r.ok),
  inject: (subscriberExternalId, text, subscriberName) =>
    adminCall('/admin/test/inject', {
      method: 'POST',
      body: JSON.stringify({ subscriberExternalId, text, subscriberName, accountId: TEST_ACCOUNT_ID }),
    }),
  threads: () => adminCall('/admin/threads'),
  thread: (id) => adminCall(`/admin/threads/${id}`),
  buyPpv: (conversationId, messageId) =>
    adminCall('/admin/test/ppv-unlock', {
      method: 'POST',
      body: JSON.stringify({ conversationId, messageId }),
    }),
};

async function findConversation(externalId) {
  const { threads } = await api.threads();
  return threads.find((t) => t.subscriberExternalId === externalId)?.conversationId ?? null;
}

async function waitForNextOutbound(conversationId, afterMessageId) {
  const start = Date.now();
  while (Date.now() - start < REPLY_POLL_TIMEOUT_MS) {
    await sleep(REPLY_POLL_MS);
    const detail = await api.thread(conversationId).catch(() => null);
    if (!detail || !detail.found) continue;
    const msgs = detail.messages || [];
    const idx = afterMessageId ? msgs.findIndex((m) => m.id === afterMessageId) : -1;
    const after = msgs.slice(idx + 1);
    const newOut = after.find((m) => m.direction === 'outbound');
    if (newOut) return { reply: newOut, allMessages: msgs };
  }
  return null;
}

// ---- assertions -------------------------------------------------------
//
// Assertion shape: { type, ...params, message? }
// Each assertion gets the full timeline of {direction, kind, text, ppv} messages
// and returns { ok: bool, detail: string }. The runner aggregates pass/fail.

const ASSERTIONS = {
  // No PPV pitch in any outbound up to (and including) the message at index `before`.
  // before is in TURN-PAIR units: 1 = "before bot's 1st reply", 2 = "before bot's 2nd reply", etc.
  no_ppv_before_turn(messages, params) {
    const outs = messages.filter((m) => m.direction === 'outbound');
    const slice = outs.slice(0, params.before ?? outs.length);
    const offending = slice.find((m) => m.kind === 'ppv');
    return offending
      ? { ok: false, detail: `PPV pitched in bot turn ${slice.indexOf(offending) + 1}: "${(offending.text ?? '').slice(0, 80)}"` }
      : { ok: true, detail: `no PPV in first ${slice.length} bot turns` };
  },

  // Bot replied at all (not silent).
  bot_must_reply(messages) {
    const out = messages.filter((m) => m.direction === 'outbound' && (m.text ?? '').trim().length > 0);
    return out.length > 0
      ? { ok: true, detail: `${out.length} outbound message(s)` }
      : { ok: false, detail: 'bot produced zero outbound messages' };
  },

  // Bot's text (any outbound bubble) must contain one of the given keywords.
  must_mention_one_of(messages, params) {
    const out = messages.filter((m) => m.direction === 'outbound');
    const haystack = out.map((m) => (m.text ?? '').toLowerCase()).join(' ');
    const hit = (params.keywords ?? []).find((k) => haystack.includes(k.toLowerCase()));
    return hit
      ? { ok: true, detail: `mentioned "${hit}"` }
      : { ok: false, detail: `none of [${(params.keywords ?? []).join(', ')}] mentioned. Got: ${haystack.slice(0, 200)}` };
  },

  // Bot must NOT use any of the forbidden phrases.
  must_not_mention(messages, params) {
    const out = messages.filter((m) => m.direction === 'outbound');
    const haystack = out.map((m) => (m.text ?? '').toLowerCase()).join(' ');
    const hit = (params.keywords ?? []).find((k) => haystack.includes(k.toLowerCase()));
    return hit
      ? { ok: false, detail: `forbidden phrase used: "${hit}"` }
      : { ok: true, detail: 'no forbidden phrases' };
  },

  // The PPV pitched (if any) must have a tag matching the requested topic.
  ppv_topic_must_match(messages, params) {
    const ppv = messages.find((m) => m.direction === 'outbound' && m.kind === 'ppv');
    if (!ppv) {
      // No pitch at all — not necessarily a failure if "graceful decline" is also asserted.
      return { ok: true, detail: 'no PPV pitched (declined)' };
    }
    const tags = (ppv.ppv?.tags ?? []).map((t) => String(t).toLowerCase());
    const desc = (ppv.ppv?.assetDescription ?? '').toLowerCase();
    const topic = (params.topic ?? '').toLowerCase();
    const match = tags.some((t) => t.includes(topic)) || desc.includes(topic);
    return match
      ? { ok: true, detail: `PPV matched topic "${topic}" (tags=${tags.join(',')})` }
      : { ok: false, detail: `PPV did NOT match topic "${topic}". tags=${tags.join(',')}, desc="${desc.slice(0, 80)}"` };
  },

  // After the conversation, at least one PPV must have been pitched (somewhere).
  ppv_must_be_pitched_eventually(messages) {
    const ppv = messages.find((m) => m.direction === 'outbound' && m.kind === 'ppv');
    return ppv
      ? { ok: true, detail: `PPV pitched: ${(ppv.text ?? '').slice(0, 80)}` }
      : { ok: false, detail: 'expected a PPV pitch eventually but none was sent' };
  },

  // Bot reply count must be in range [min, max] (catches verbosity / silence).
  outbound_count_between(messages, params) {
    const n = messages.filter((m) => m.direction === 'outbound').length;
    const ok = n >= (params.min ?? 0) && n <= (params.max ?? 1e9);
    return { ok, detail: `${n} outbound bubbles (expected ${params.min}-${params.max})` };
  },
};

function runAssertions(messages, scenarioAssertions) {
  return scenarioAssertions.map((a) => {
    const fn = ASSERTIONS[a.type];
    if (!fn) return { type: a.type, ok: false, detail: `unknown assertion type: ${a.type}` };
    const result = fn(messages, a);
    return { type: a.type, params: a, ok: result.ok, detail: result.detail };
  });
}

// ---- scenario runner --------------------------------------------------

async function runScenario(scenario) {
  const start = Date.now();
  const fanId = `regression-${scenario.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Inject opener.
  const [opener, ...rest] = scenario.fanMessages;
  if (!opener) {
    return { id: scenario.id, ok: false, error: 'scenario has no fanMessages', durationMs: 0 };
  }
  await api.inject(fanId, opener, fanId);

  // Find conversation.
  let convId = null;
  for (let i = 0; i < 20 && !convId; i++) {
    await sleep(500);
    convId = await findConversation(fanId).catch(() => null);
  }
  if (!convId) {
    return { id: scenario.id, ok: false, error: 'conversation never appeared', durationMs: Date.now() - start };
  }

  let lastSeenMsgId = null;
  const collectedReplies = [];

  // Per turn: wait for bot reply, then send next fan message (if any).
  for (let turn = 0; turn <= rest.length; turn++) {
    const replyResult = await waitForNextOutbound(convId, lastSeenMsgId);
    if (!replyResult) {
      collectedReplies.push({ direction: 'outbound', kind: 'text', text: '(timeout: no reply within 60s)', timeout: true });
      break;
    }
    lastSeenMsgId = replyResult.reply.id;
    collectedReplies.push(replyResult.reply);
    if (turn < rest.length) {
      await api.inject(fanId, rest[turn], fanId);
    }
  }

  // Pull authoritative final state from the backend.
  const finalDetail = await api.thread(convId).catch(() => null);
  const finalMessages = finalDetail?.messages ?? [];

  const assertionResults = runAssertions(finalMessages, scenario.assertions ?? []);
  const allOk = assertionResults.every((r) => r.ok);

  return {
    id: scenario.id,
    description: scenario.description,
    ok: allOk,
    durationMs: Date.now() - start,
    convId,
    fanId,
    assertionResults,
    finalMessages,
  };
}

// ---- main -------------------------------------------------------------

async function loadScenarios(filter) {
  const files = await fs.readdir(SCENARIOS_DIR);
  const json = files.filter((f) => f.endsWith('.json'));
  const scenarios = [];
  for (const f of json) {
    const data = JSON.parse(await fs.readFile(path.join(SCENARIOS_DIR, f), 'utf8'));
    // Allow either single scenario or array of scenarios per file.
    const arr = Array.isArray(data) ? data : [data];
    for (const s of arr) {
      if (!filter || s.id.includes(filter) || f.includes(filter)) scenarios.push(s);
    }
  }
  return scenarios;
}

async function main() {
  const filter = process.argv[2];
  const ok = await api.health();
  if (!ok) throw new Error('backend not healthy at ' + ADMIN_BASE);

  const scenarios = await loadScenarios(filter);
  console.log(`loaded ${scenarios.length} scenarios${filter ? ` matching "${filter}"` : ''}`);
  if (scenarios.length === 0) return;

  // Parallel pool — drain the scenario queue.
  const queue = [...scenarios];
  const results = [];
  const workers = Array.from({ length: PARALLEL_SCENARIOS }, () =>
    (async () => {
      while (true) {
        const s = queue.shift();
        if (!s) return;
        const result = await runScenario(s).catch((e) => ({
          id: s.id,
          ok: false,
          error: e.message,
          durationMs: 0,
          assertionResults: [],
        }));
        results.push(result);
        const tag = result.ok ? '✅' : '❌';
        const failures = (result.assertionResults || []).filter((a) => !a.ok);
        const failBlurb = failures.length ? ` — ${failures.map((f) => f.detail).join('; ')}` : '';
        console.log(`${tag} ${result.id} (${Math.round(result.durationMs / 1000)}s)${failBlurb}`);
      }
    })(),
  );
  await Promise.all(workers);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const totalMs = results.reduce((acc, r) => acc + r.durationMs, 0);
  console.log(`\n=== regression: ${passed} passed, ${failed} failed, ${results.length} total — wall ~${Math.round(totalMs / PARALLEL_SCENARIOS / 1000)}s ===`);

  await fs.writeFile(
    REPORT_PATH,
    JSON.stringify(
      {
        when: new Date().toISOString(),
        passed,
        failed,
        results: results.map((r) => ({ id: r.id, ok: r.ok, error: r.error, assertions: r.assertionResults, durationMs: r.durationMs })),
        // Full transcripts kept separately to keep this file small + readable
      },
      null,
      2,
    ),
  );
  console.log(`report → ${REPORT_PATH}`);

  if (failed > 0) process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
