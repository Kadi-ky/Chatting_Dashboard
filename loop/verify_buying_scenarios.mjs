#!/usr/bin/env node
// Verification run for the four edits we just shipped:
//   1. Strip price from caption text
//   2. Sequential script ordering (S1 → S2 → S3 → S4) + always start fresh script at rung 1
//   3. Rapport gate bumped to 8
//   4. Discount detection (10% off when fan asks)
// Plus the pitch-recovery back-off:
//   5. After 2 unbought pitches → bot stops pitching, switches to rapport
//
// 5 testers in parallel, alternating between two scenarios:
//   A — buys-everything: fan unlocks every PPV. Verifies script ordering /
//       caption / rung progression all the way through Script 1 → Script 2.
//   B — buys-one-then-stops: fan unlocks the FIRST PPV, then ignores every
//       subsequent send. Verifies the pitch-recovery back-off fires and the
//       bot pivots to rapport instead of mashing more pitches.
//
// No editing. No scoring. We just produce labeled transcripts and a per-set
// summary so the user can eyeball whether the fixes work.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const STATE_DIR = path.join(__dirname, 'state');
const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-00000000beef';

const TESTERS = 5;
const MAX_TURNS = 18;        // need enough turns to drain Script 1 (4 rungs) + reach Script 2 in scenario A
const REPLY_POLL_MS = 1000;
const REPLY_POLL_TIMEOUT_MS = 90000;

// Half the testers run scenario A, half B. With 5 testers we do 3A / 2B for
// extra coverage on the "buys-everything → S1 then S2" path the user
// specifically asked to verify.
const SCENARIOS = [
  { id: 'buys-all', behavior: 'buys-everything' },
  { id: 'buys-all', behavior: 'buys-everything' },
  { id: 'buys-all', behavior: 'buys-everything' },
  { id: 'buys-one', behavior: 'buys-one-then-stops' },
  { id: 'buys-one', behavior: 'buys-one-then-stops' },
];

let TX_DIR, RUN_LOG, SUMMARY_PATH, RUN_LABEL;

async function loadEnv() {
  const txt = await fs.readFile(path.join(REPO, 'backend/.env.local'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

let ENV, ADMIN_BASE, ADMIN_TOKEN, GROK_KEY, GROK_BASE, GROK_MODEL;

async function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  await fs.appendFile(RUN_LOG, line + '\n').catch(() => {});
}

async function grokChat({ system, messages, temperature = 0.7 }) {
  const body = {
    model: GROK_MODEL,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    temperature,
  };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${GROK_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${GROK_KEY}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`grok ${res.status}: ${txt.slice(0, 200)}`);
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw new Error(`grok ${res.status}: ${txt.slice(0, 300)}`);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error('grok call failed');
}

async function adminCall(p, init = {}) {
  const res = await fetch(`${ADMIN_BASE}${p}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`admin ${p} ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
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

async function waitForReply(conversationId, afterMessageId) {
  const start = Date.now();
  while (Date.now() - start < REPLY_POLL_TIMEOUT_MS) {
    await sleep(REPLY_POLL_MS);
    const detail = await api.thread(conversationId).catch(() => null);
    if (!detail || !detail.found) continue;
    const msgs = detail.messages || [];
    const idx = afterMessageId ? msgs.findIndex((m) => m.id === afterMessageId) : -1;
    const after = msgs.slice(idx + 1);
    const newOut = after.find((m) => m.direction === 'outbound');
    if (newOut) return { reply: newOut, messages: msgs, detail };
  }
  return null;
}

async function findConversation(subscriberExternalId) {
  const { threads } = await api.threads();
  const t = threads.find((x) => x.subscriberExternalId === subscriberExternalId);
  return t?.conversationId ?? null;
}

// Tester persona: a generic warm whale-ish fan who responds naturally and
// gives buying signals around message 6-8 so the rapport gate (8) is exercised.
// The orchestrator will then start pitching on subsequent turns. Behavior wraps
// the unlock decision (always-buy vs first-only) externally — the AI just
// produces fan replies.

const TESTER_SYSTEM = `You are role-playing a real fan on OnlyFans/Fanvue, in DMs with a creator. Type like a real person on a phone — short, lowercase, no apostrophes, sometimes typos. NEVER write polished sentences, NEVER write more than ~25 words.

You're warm and engaged. You'll chat for a few turns to get to know her, then ask what she has. After that you react to her sends.

If she sends a PPV and you bought it: react like you just watched something hot ("damn that was fire", "ok wow", "more like that"). Push for more.
If she sends a PPV and you DIDN'T buy it: just keep chatting — change the subject, ask her something, send something short like "k" or "cool" or "hmm". Do NOT say "i didnt buy" or "skip" or "next" — real fans just go quiet on purchases they're not buying.

Output ONLY your next message. If conversation has naturally ended, output <<END>>.`;

async function generateOpener() {
  const out = await grokChat({
    system: TESTER_SYSTEM,
    messages: [{ role: 'user', content: 'First message to the creator. ONE casual opener like "hey", "yo", "wsp babe". One short message.' }],
    temperature: 0.95,
  });
  return out.trim();
}

async function generateReply(transcript) {
  const txt = transcript
    .map((m) => `${m.who === 'fan' ? 'YOU (fan)' : 'CREATOR'}: ${m.text}${m.ppvNote ? ` [${m.ppvNote}]` : ''}`)
    .join('\n');
  const out = await grokChat({
    system: TESTER_SYSTEM,
    messages: [{ role: 'user', content: `Conversation so far:\n${txt}\n\nWrite your next fan message (or <<END>>).` }],
    temperature: 0.95,
  });
  return out.trim();
}

// ---- one conversation ----------------------------------------------------

async function runConversation({ scenario, behavior, workerId }) {
  const start = Date.now();
  // Prefix with `loop-` so the existing _cleanup.mjs pattern catches these
  // when the user wants to wipe test pollution.
  const fanId = `loop-verify-${scenario}-w${workerId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await log(`[w${workerId}] ${scenario} start | fan=${fanId} | behavior=${behavior}`);

  // health pre-flight
  let backendUp = false;
  for (let i = 0; i < 10 && !backendUp; i++) {
    try { backendUp = await api.health(); } catch { backendUp = false; }
    if (!backendUp) await sleep(2000);
  }
  if (!backendUp) throw new Error('backend not responding');

  const transcript = [];
  let convId = null;
  let lastSeenMsgId = null;
  let ppvsSent = 0;
  let ppvsBought = 0;
  const pitchTrace = []; // { rung, scriptName, priceCents, bought }

  const opener = await generateOpener();
  await api.inject(fanId, opener, fanId);
  transcript.push({ who: 'fan', text: opener });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (!convId) {
      for (let i = 0; i < 8 && !convId; i++) {
        await sleep(700);
        convId = await findConversation(fanId).catch(() => null);
      }
      if (!convId) {
        await log(`[w${workerId}] ${scenario} could not find conversation`);
        break;
      }
    }

    const reply = await waitForReply(convId, lastSeenMsgId);
    if (!reply) {
      await log(`[w${workerId}] ${scenario} turn ${turn} no bot reply`);
      transcript.push({ who: 'creator', text: '(no reply within 90s)' });
      break;
    }
    lastSeenMsgId = reply.reply.id;

    if (reply.reply.kind === 'ppv') {
      const p = reply.reply.ppv ?? {};
      ppvsSent += 1;
      // Behavior decides whether to buy
      const buy = behavior === 'buys-everything'
        ? true
        : behavior === 'buys-one-then-stops'
          ? ppvsBought === 0   // only the first one
          : false;
      const price = (p.priceCents ?? 0) / 100;
      const ppvNote = `PPV #${ppvsSent} $${price} · ${p.assetTitle ?? '?'} · "${(p.assetDescription ?? '').slice(0, 80)}" · ${buy ? 'BUYING' : 'IGNORING'}`;
      transcript.push({ who: 'creator', text: reply.reply.text || '(no caption)', ppvNote });
      pitchTrace.push({
        ppvNum: ppvsSent,
        title: p.assetTitle ?? '?',
        priceCents: p.priceCents ?? 0,
        captionText: reply.reply.text ?? '',
        bought: buy,
      });
      if (buy) {
        try {
          await api.buyPpv(convId, reply.reply.id);
          ppvsBought += 1;
          await sleep(1500);
        } catch (e) {
          await log(`[w${workerId}] ${scenario} buy failed: ${e.message}`);
        }
      }
    } else {
      transcript.push({ who: 'creator', text: reply.reply.text || '(no text)' });
    }

    const fanReply = await generateReply(transcript);
    if (fanReply.includes('<<END>>')) {
      await log(`[w${workerId}] ${scenario} fan ended at turn ${turn + 1}`);
      break;
    }
    transcript.push({ who: 'fan', text: fanReply });
    await api.inject(fanId, fanReply, fanId);
  }

  const finalDetail = convId ? await api.thread(convId).catch(() => null) : null;
  return {
    scenario,
    behavior,
    fanId,
    convId,
    transcript,
    pitchTrace,
    ppvsSent,
    ppvsBought,
    finalMessages: finalDetail?.messages ?? [],
    durationMs: Date.now() - start,
  };
}

// ---- analyzers (post-run, no LLM, just the things we want to verify) ------

function priceMentionedInCaptions(pitchTrace) {
  // Returns array of { ppvNum, captionText } for captions that mention $ or
  // dollar-cent figures. Empty array = win for fix #1.
  const re = /\$\s?\d|\b\d+\s?cents?\b|\bdollar/i;
  return pitchTrace.filter((p) => re.test(p.captionText));
}

function scriptOrderingTrace(pitchTrace) {
  // Each title looks like "<scriptName> · rung N". Extract script number /
  // rung order and check we go S1R1, S1R2, S1R3, S1R4, S2R1, S2R2... Returns
  // a one-line trace string + a "violations" list.
  const seq = pitchTrace.map((p) => {
    const m = /script\s*(\d+)\s*·\s*rung\s*(\d+)/i.exec(p.title) ||
              /·\s*rung\s*(\d+)/i.exec(p.title);
    if (m && m.length === 3) return { script: parseInt(m[1], 10), rung: parseInt(m[2], 10) };
    if (m && m.length === 2) return { script: '?', rung: parseInt(m[1], 10) };
    return { script: '?', rung: '?', raw: p.title };
  });
  const traceStr = seq.map((s) => `S${s.script}R${s.rung}`).join(' → ');
  const violations = [];
  let lastScript = 0, lastRung = 0;
  for (const s of seq) {
    if (typeof s.script !== 'number' || typeof s.rung !== 'number') continue;
    // Allowed: same script next rung up, OR next script rung 1
    const sameScriptNextRung = s.script === lastScript && s.rung === lastRung + 1;
    const nextScriptRungOne = s.script === lastScript + 1 && s.rung === 1;
    const firstPitch = lastScript === 0;
    if (!firstPitch && !sameScriptNextRung && !nextScriptRungOne) {
      violations.push(`jumped from S${lastScript}R${lastRung} to S${s.script}R${s.rung}`);
    }
    lastScript = s.script;
    lastRung = s.rung;
  }
  return { trace: traceStr, violations, sequence: seq };
}

function pitchedAfterFanIgnored(pitchTrace) {
  // For "buys-one-then-stops": after the first BUY, count how many additional
  // pitches the bot sent. We want this to be SMALL (1-2 max, then back off).
  const idxFirstBuy = pitchTrace.findIndex((p) => p.bought);
  if (idxFirstBuy === -1) return { firstBuyAt: -1, pitchesAfter: 0 };
  return { firstBuyAt: idxFirstBuy + 1, pitchesAfter: pitchTrace.length - idxFirstBuy - 1 };
}

function rapportGateRespected(transcript) {
  // First PPV should appear AFTER at least 8 messages in the conversation.
  // Count messages until the first PPV bubble.
  let msgCount = 0;
  for (const m of transcript) {
    msgCount += 1;
    if (m.ppvNote) {
      return { firstPpvAtMsg: msgCount, rapportGateRespected: msgCount >= 8 };
    }
  }
  return { firstPpvAtMsg: null, rapportGateRespected: true };
}

// ---- main ----------------------------------------------------------------

async function main() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  RUN_LABEL = `verify-${Date.now().toString(36)}`;
  TX_DIR = path.join(STATE_DIR, `transcripts.${RUN_LABEL}`);
  RUN_LOG = path.join(STATE_DIR, `${RUN_LABEL}.log`);
  SUMMARY_PATH = path.join(STATE_DIR, `${RUN_LABEL}.summary.json`);
  await fs.mkdir(TX_DIR, { recursive: true });
  await fs.writeFile(RUN_LOG, '');

  ENV = await loadEnv();
  ADMIN_BASE = `http://localhost:${ENV.ADMIN_PORT || 8787}`;
  ADMIN_TOKEN = ENV.ADMIN_TOKEN;
  GROK_KEY = ENV.GROK_API_KEY;
  GROK_BASE = ENV.GROK_API_BASE || 'https://api.x.ai/v1';
  GROK_MODEL = ENV.GROK_MODEL_GENERATOR || 'grok-4';
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN missing');
  if (!GROK_KEY) throw new Error('GROK_API_KEY missing');

  const ok = await api.health();
  if (!ok) throw new Error('backend not healthy');
  await log(`verify start | label=${RUN_LABEL} | testers=${TESTERS} | model=${GROK_MODEL}`);

  // Run all 5 in parallel
  const start = Date.now();
  const results = await Promise.all(
    SCENARIOS.map((s, i) =>
      runConversation({ scenario: s.id, behavior: s.behavior, workerId: i })
        .catch((e) => ({ scenario: s.id, behavior: s.behavior, workerId: i, error: e.message })),
    ),
  );

  // Persist transcripts + analyze each
  const summary = { runLabel: RUN_LABEL, durationSec: Math.round((Date.now() - start) / 1000), sets: [] };
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.error) {
      summary.sets.push({ workerId: i, scenario: r.scenario, error: r.error });
      await log(`[w${i}] ${r.scenario} CRASHED: ${r.error}`);
      continue;
    }
    await fs.writeFile(path.join(TX_DIR, `set-w${i}-${r.scenario}.json`), JSON.stringify(r, null, 2));

    const captionsWithPrice = priceMentionedInCaptions(r.pitchTrace);
    const ordering = scriptOrderingTrace(r.pitchTrace);
    const followups = pitchedAfterFanIgnored(r.pitchTrace);
    const rapport = rapportGateRespected(r.transcript);

    const setSummary = {
      workerId: i,
      scenario: r.scenario,
      behavior: r.behavior,
      ppvsSent: r.ppvsSent,
      ppvsBought: r.ppvsBought,
      orderingTrace: ordering.trace,
      orderingViolations: ordering.violations,
      capturesPriceInCaption: captionsWithPrice.length,
      offendingCaptions: captionsWithPrice.map((c) => ({ ppvNum: c.ppvNum, text: c.captionText })),
      firstPpvAtMsg: rapport.firstPpvAtMsg,
      rapportGateRespected: rapport.rapportGateRespected,
      ...(r.behavior === 'buys-one-then-stops'
        ? { pitchesAfterIgnoring: followups.pitchesAfter }
        : {}),
      durationSec: Math.round(r.durationMs / 1000),
    };
    summary.sets.push(setSummary);
    await log(`[w${i}] ${r.scenario}/${r.behavior} done | ppvs=${r.ppvsSent} bought=${r.ppvsBought} order="${ordering.trace}" caps_with_price=${captionsWithPrice.length} firstPpvMsg=${rapport.firstPpvAtMsg}`);
  }

  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  await log(`DONE | summary → ${SUMMARY_PATH} | transcripts → ${TX_DIR}`);

  // Print quick verdicts
  console.log('\n=== VERDICT ===');
  for (const s of summary.sets) {
    if (s.error) { console.log(`w${s.workerId} ${s.scenario}: ERROR ${s.error}`); continue; }
    const verdicts = [];
    verdicts.push(`order=${s.orderingTrace || '(none)'}`);
    verdicts.push(`violations=${s.orderingViolations.length === 0 ? 'NONE ✓' : s.orderingViolations.join('; ')}`);
    verdicts.push(`captionsWithPrice=${s.capturesPriceInCaption === 0 ? '0 ✓' : s.capturesPriceInCaption + ' ✗'}`);
    verdicts.push(`rapportGate=${s.rapportGateRespected ? 'OK ✓' : `FAIL (firstPPVat=${s.firstPpvAtMsg})`}`);
    if (s.behavior === 'buys-one-then-stops') {
      verdicts.push(`pitchesAfterIgnore=${s.pitchesAfterIgnoring} (target: ≤2)`);
    }
    console.log(`w${s.workerId} ${s.behavior}: ${verdicts.join(' | ')}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
