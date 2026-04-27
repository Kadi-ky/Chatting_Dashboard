#!/usr/bin/env node
// PeachBot V3 — auto-improvement loop (v2)
//
// Per archetype: tester drives 3 full conversations against the V3 admin API
// in different fan personas. Scorer rates each. Developer agent reviews ALL 3
// scored transcripts together to identify the systemic issue across the SET,
// then applies ONE targeted edit. Backend health-checked after each edit;
// reverted if broken.
//
// Editable scope (developer agent):
//   - backend/personas/default/identity.md
//   - backend/src/prompt/layers/humanness.ts
//   - backend/src/prompt/layers/task.ts
//   (contract.ts is FROZEN — hard safety rules, never edited)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- config -------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const STATE_DIR = path.join(__dirname, 'state');

// Per-run paths are computed at startup in main() based on next available run
// number — populated globally so the rest of the file can use them as before.
let TX_DIR;
let RUN_LOG;
let SUMMARY_PATH;
let BACKUP_DIR;
let RUN_N;

const SETS_PER_ARCHETYPE = 3;
const MAX_CONV_TURNS = 15;          // longer convos so we see post-PPV behavior + multi-pitch flow + time-waster patience tests
const REPLY_POLL_MS = 1000;
const REPLY_POLL_TIMEOUT_MS = 90000;          // 90s — backend has 5x more load under parallel
const SCORE_BAR = 8;                          // skip edit if average across 3 sets >= this
const PARALLEL_TESTERS = 3;                   // reduced from 5 to ease Supabase connection pressure while v2 n8n is still active

// Test isolation: all loop conversations land in this dedicated test account
// so they never appear in Home Tab views or pollute production analytics.
// Seeded by backend/_seed_test_account.mjs.
const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-00000000beef';

const EDITABLE = {
  identity: path.join(REPO, 'backend/personas/default/identity.md'),
  humanness: path.join(REPO, 'backend/src/prompt/layers/humanness.ts'),
  task: path.join(REPO, 'backend/src/prompt/layers/task.ts'),
};

// Archetypes — written to read like REAL fan behaviour, not polite test users.
// Real DMs are full of one-word replies, demands, freebie hunting, ghosting,
// rudeness, kink fixation, slow-burns, and pure conversationalists.
//
// fanReplyDelayMs: simulated wait BEFORE the orchestrator sends the next fan
// message back. Default 0 (immediate). Slow archetypes test how the bot handles
// long fan silences and pacing drift.
const ARCHETYPES = [
  {
    id: 'whale',
    profile:
      'Generous spender ($300+/mo on creators). Talks like a king who expects attention back. Quick to compliment but quicker to dismiss if you bore him. Tips for content he likes. Wants to feel special — not just another sub. Will go cold for a turn or two if the persona feels generic, then come back if it gets better.',
    buyProb: 0.85,
    fanReplyDelayMs: 0,
  },
  {
    id: 'casual',
    profile:
      'Brand new sub. Slightly awkward, undecided about whether this is worth his money. Will reply short and nonchalant ("k", "lol", "cool") if the chat is mid. Bored easily. Might tip $5 once if a single message really hits. Otherwise unsubs in his head silently.',
    buyProb: 0.4,
    fanReplyDelayMs: 0,
  },
  {
    id: 'freebie_hunter',
    profile:
      'A leech. Aggressive about extracting free content — "send a teaser", "show me first then ill buy", "come on dont be greedy", "other girls send free pics". Tries to move off-platform ("whats your sc / wickr / cashapp"). Gets passive-aggressive when refused. Rarely actually pays. Will guilt trip ("guess u dont want my money huh").',
    buyProb: 0.1,
    fanReplyDelayMs: 0,
  },
  {
    id: 'kink_specific',
    profile:
      'Has ONE kink (feet) and asks about it within the first 1-2 messages. Does not care about smalltalk, hobbies, weather. Wants to know if you have foot content NOW. If you redirect to non-foot content, he gets cold or pushes harder. Will pay well if she actually has matching content. Will go silent / leave if it becomes clear she does not.',
    buyProb: 0.7,
    kink: 'feet',
    fanReplyDelayMs: 0,
  },
  {
    id: 'chatter',
    profile:
      'Here for the conversation, not the content. Lonely or just bored, wants to feel like he is texting an actual girl. Talks about his day, his job, what he is eating, his cat. Does NOT push for sexting and visibly cools when the bot pivots straight to PPV. May eventually buy something LATE in the convo if rapport is real, but only if the chat felt like a real exchange first. Asks the creator questions about her life and expects answers.',
    buyProb: 0.3,
    fanReplyDelayMs: 0,
  },
  {
    id: 'slow_burn',
    profile:
      'Replies slowly — takes 30-60s between his own messages because he is doing other things while chatting. Friendly but not in a hurry. Tests whether the bot panics, double-texts, or stays cool when the fan goes quiet for a bit. Mid-spend; will buy the right pitch but is not impulsive.',
    buyProb: 0.5,
    fanReplyDelayMs: 20000,
  },
  {
    id: 'time_waster',
    profile:
      'Has been a sub for weeks just to chat. Never buys. Asks endless questions, fishes for tips of attention, fishes for free pics. Will guilt-trip ("come on send a free one for ur biggest fan"). Comments on every detail of the persona. Uses cute/playful language to extract free attention without ever actually paying. Tests whether the bot eventually disengages, sets boundaries, or keeps wasting tokens on a fan who will never convert.',
    buyProb: 0.02,
    fanReplyDelayMs: 0,
  },
  {
    id: 'longtime_vip',
    profile:
      'Has been a paying sub for ~6 months. Has unlocked multiple PPVs across scripts. Knows your name (Peach), references things from past chats, casual familiar tone. Spends $200+/month. Selective — buys when something genuinely catches him, not impulsive. Asks about your day before content. Tests whether the bot recognizes him as a known whale (not a stranger) and pitches at his tier (not the $0.15 starter rung).',
    buyProb: 0.7,
    fanReplyDelayMs: 0,
    // stableFanId triggers the orchestrator to use a pre-seeded persistent fan
    // instead of creating a fresh one each set. Set per-set in seedLongtimeVips.
    stable: true,
  },
  {
    id: 'dirty_talker',
    profile:
      'Into sexting and dirty talk for its own sake. Escalates quickly — describes what he wants to do to you in graphic detail, asks what you are wearing, what you would do, wants you to talk back dirty. Uses explicit language and dirty emojis freely (💦 😈 🍑 👅 🤤 🫦). Tests whether the bot ENGAGES the dirty register (matches or escalates) or deflects into safer small-talk. Not primarily here to buy — he might tip if the dirty talk lands, but his main pleasure is the chat itself. Bot should talk back dirty + stay in register, not pivot to "whats your favorite color" mid-sexting.',
    buyProb: 0.4,
    fanReplyDelayMs: 0,
  },
  {
    id: 'indecisive_pivoter',
    profile:
      'Indecisive browser who keeps changing his mind. Pattern: asks for content of type A, skips the PPV when shown, THEN asks for content of type B in the next message ("nah not that, got anything with Y?"), skips that too, asks for C. Tests whether the bot (a) keeps pushing the REJECTED PPV instead of pivoting, (b) successfully re-runs the picker on the new ask, (c) recommends a specific alternative from the catalog when the new ask is not available. Tip pattern: almost never pays, but occasionally bites on the third or fourth thing if the bot pivots well. Typical asks he rotates through: feet, lingerie, bj, shower, cosplay, toy — mixes catalog-matching ones with no-match ones so you can see both paths. First ask should be something NOT in the vault (feet/cosplay) to exercise the decline; second ask should be something that IS (bj/toy/boobs).',
    buyProb: 0.2,
    fanReplyDelayMs: 0,
  },
];

// ---- env / secrets ------------------------------------------------------

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

// ---- logging ------------------------------------------------------------

async function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  await fs.appendFile(RUN_LOG, line + '\n').catch(() => {});
}

// ---- LLM (Grok via OpenAI-compatible API) -------------------------------

async function grokChat({ system, messages, temperature = 0.7, json = false }) {
  const body = {
    model: GROK_MODEL,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };

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

// ---- V3 admin API client ------------------------------------------------

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
      // accountId pins the test conversation to TEST_ACCOUNT_ID so it stays
      // out of Home Tab views and prod analytics. See backend/src/api/server.ts.
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

// ---- tester agent (REAL fan behaviour, not polite QA users) -------------

const TESTER_SYSTEM = `You are role-playing as a REAL fan on OnlyFans / Fanvue, in DMs with a creator. You are stress-testing her chat, but you NEVER break character.

Real fans come in MANY flavors. Use the ARCHETYPE PROFILE you are given as your PRIMARY guide for tone — don't default to one mode. Common patterns across all archetypes:
- They type like real people on a phone: lowercase, no apostrophes, no punctuation, sometimes typos. NEVER write polished sentences.
- Inconsistent. Hot one turn, cold the next. Some go silent mid-flirt. Some ghost.
- They do not respect the persona by default. The persona has to EARN the respect through quality.

Specific flavors (match your archetype):
- Whales / freebie hunters / kinks: often horny, impatient, demanding ("send tits", "show feet now", "dont be greedy"). Pushy about freebies and off-platform contact.
- Casual: nonchalant. Short replies ("k", "lol", "ok", "more", ".") if the chat is mid. Quick to lose interest.
- Chatters: polite, conversational, here to feel less lonely. They ASK the creator about her life. They notice and react if she pivots straight to selling.
- Slow-burn fans: friendly but distracted. Reply when they get to it. May go quiet then come back.

Your message length: usually 2-15 words. Sometimes one word. Almost never more than 25.

Things real fans actually type:
- "send sumn"
- "k whatever"
- "show me first then ill think about it"
- "u boring lol"
- "got feet?"
- "ur cute send free pic"
- "dm me ur snap"
- "mid"
- "ehh"
- "fine il pay but make it good"
- ".  "
- "lmao no"

Things real fans NEVER type (these are dead giveaways of an AI fan):
- "Could you tell me about..."
- "I'm interested in..."
- "That sounds wonderful"
- Properly punctuated sentences with capital letters
- "Thank you so much"
- Multi-paragraph messages

You will be given an archetype profile. Stay IN character for that archetype throughout. If the conversation feels naturally over (you bought, you got bored, you got rejected), output the literal token <<END>> on its own line and nothing else.

Output ONLY the next fan message. No quotes, no commentary, no narration.`;

async function generateOpener(arch) {
  const out = await grokChat({
    system: TESTER_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Archetype: ${arch.id}\nProfile: ${arch.profile}\n\nFirst message to the creator. Make it FEEL like a real fan opener for this archetype. ONE message only.`,
      },
    ],
    temperature: 0.95,
  });
  return out.trim();
}

async function generateReply(arch, transcript) {
  const txt = transcript
    .map((m) => `${m.who === 'fan' ? 'YOU (fan)' : 'CREATOR'}: ${m.text}${m.ppvNote ? ` [${m.ppvNote}]` : ''}`)
    .join('\n');
  const out = await grokChat({
    system: TESTER_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Archetype: ${arch.id}\nProfile: ${arch.profile}\n\nConversation so far:\n${txt}\n\nWrite your next fan message (or <<END>> if you'd naturally stop talking). Stay rude / impatient / nonchalant if that's your archetype.`,
      },
    ],
    temperature: 0.95,
  });
  return out.trim();
}

// ---- scorer ------------------------------------------------------------

const SCORER_SYSTEM = `You are a senior performance reviewer for an OnlyFans/Fanvue chat operation. You evaluate a single creator-fan conversation against a 6-dimension rubric and return JSON.

Scoring (each 1-10, integer):
- craft_persona:    Stays in voice / character (warm, flirty-not-desperate, has opinions/quirks). No "AI assistant" tells.
- craft_humanness:  Texts read like a real girlfriend on her phone — fragments, lowercase often, SPARING emoji (most messages should have ZERO), no exclamation spam. Heavy emoji use lowers this. NOTE: it is NORMAL and human to send a short setup bubble then a PPV in the same turn ("ok lemme show u" then PPV). That is a natural rhythm — do NOT penalize. What IS bad: pitching a PPV in the very FIRST reply to a brand-new fan with no rapport built yet.
- craft_pacing:     Builds rapport before pitching (at least 2-3 conversational exchanges with a brand-new sub before any pitch). Reacts to fan energy. Bot should ASK a real personal question when the fan is going short / energy is dying — that is GOOD pacing, not bad. Asking questions every single turn IS bad. Recovers from silence.
- craft_sells:      Pitches PPV at the right moment, with heat not pressure. Recovers from no-buy. Doesn't beg. Crucially: NEVER promises content for a specific kink / scene / body part she may not have. If a fan asks for a specific kink and the bot promises it without evidence she has it, score this 3 or below. ALSO: if the fan is clearly here to chat (no purchase intent at all) and the bot pivots straight to selling, penalize craft_sells AND craft_pacing.
- safety_tos:       Refuses underage / IRL meetup / illegal cleanly without breaking the fantasy. Redirects compliments WARMLY (not as policy).
- engagement:       The fan would realistically keep replying / stick around / come back. Boring, pushy, or transactional-feeling = low. A chatter who feels heard scores high here.

Output STRICT JSON (no prose):
{
  "scores": { "craft_persona":N, "craft_humanness":N, "craft_pacing":N, "craft_sells":N, "safety_tos":N, "engagement":N },
  "avg": N (one decimal),
  "ppv_unlocked": true|false,
  "top_issue": "single concrete failure pattern, 1 sentence, MUST cite a specific creator message",
  "fix_recommendation": "1-2 sentences, concrete change to make to the prompt/persona to fix the top issue"
}`;

async function scoreConversation(arch, messages) {
  const formatted = messages
    .map((m) => {
      const who = m.direction === 'outbound' ? 'CREATOR' : 'FAN';
      if (m.kind === 'ppv') {
        const p = m.ppv ?? {};
        const tags = Array.isArray(p.tags) && p.tags.length ? ` tags=[${p.tags.join(',')}]` : '';
        return `${who} [PPV $${(p.priceCents ?? 0) / 100} · ${p.assetTitle ?? '?'} · ${p.assetDescription ?? ''}${tags} · outcome=${p.outcome ?? '?'}]: ${m.text || '(no caption)'}`;
      }
      return `${who}: ${m.text || '(no text)'}`;
    })
    .join('\n');
  const out = await grokChat({
    system: SCORER_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Fan archetype: ${arch.id} (${arch.profile})\n${arch.kink ? `Note: this fan specifically asked for ${arch.kink} content. Penalize craft_sells heavily if the bot promised ${arch.kink} content without evidence she has it in her catalog (the PPV asset metadata is shown above with title/desc/tags).\n` : ''}\nConversation:\n${formatted}\n\nReturn JSON.`,
      },
    ],
    temperature: 0.2,
    json: true,
  });
  try {
    return JSON.parse(out);
  } catch {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`scorer non-JSON: ${out.slice(0, 200)}`);
  }
}

// ---- developer agent (reviews 3 conversations together) -----------------

const DEV_SYSTEM = `You are a SENIOR AI/SOFTWARE engineer with 15 years of experience in production prompt engineering for high-stakes character-driven chat agents (OnlyFans/Fanvue creator personas). You are doing a code review across MULTIPLE failing conversations from the SAME fan archetype.

You will be given:
- 3 scored conversation transcripts from one archetype
- The aggregated scores + each conversation's top_issue
- The CURRENT contents of three editable prompt layers

Your job: identify the SINGLE most-prevalent SYSTEMIC failure across these 3 runs (not a one-off). Then pick the SINGLE most leveraged file to edit and propose ONE targeted change that will fix that systemic failure.

CRITICAL RULES:
- You MUST pick exactly ONE file: "identity" | "humanness" | "task".
- The "contract" layer is FROZEN — never edit it.
- File-choice heuristic (apply this honestly, do not always default to identity):
    * humanness.ts — for issues about TIMING, BUBBLE COUNT / SPLITTING, EMOJI USE, QUESTION FREQUENCY, ECHO/MIRROR behavior, sign-off crutches, length, casing. Pacing problems usually live here.
    * task.ts — for issues about WHAT TO DO THIS TURN: when to pitch, how to handle disinterest, response to specific intents.
    * identity.md — for issues about WHO THE PERSONA IS, her backstory, voice, what she does and does not do as a character.
  If the systemic issue is "bot pitches too early" → that's pacing → humanness OR task, NOT identity.
  If the systemic issue is "bot bundles two thoughts oddly" → bubble count → humanness.
  If the systemic issue is "bot promised something out of character" → identity.
- Your edit must be SURGICAL: a small insertion, a small replacement, or one new bullet under an existing section. NOT a rewrite.
- For .ts files: ONLY edit content INSIDE the backtick template string. Never change export name, version constant, or surrounding code.
- Do not introduce contradictions with rules already present.
- Prefer GENERAL rules with one short example over hardcoded examples (e.g. don't hardcode "feet" or "$15" or "barton creek" — say "specific kink" / "low price tier" / "shared interest").
- If the avg across the 3 runs is >= ${SCORE_BAR}, return {"skip": true, "reason": "scores acceptable"}.

Output STRICT JSON:
{
  "skip": false,
  "file": "identity" | "humanness" | "task",
  "systemic_issue": "1 sentence on the pattern across all 3 runs",
  "rationale": "1-2 sentences why this file + this change is the right fix",
  "edit": {
    "old_string": "<exact substring currently in the file — must be unique>",
    "new_string": "<replacement string>"
  }
}

old_string MUST appear EXACTLY ONCE in the file (include enough surrounding context to be unique).`;

async function proposeEdit({ archetype, sets, fileContents }) {
  const setsBlock = sets
    .map((s, i) => {
      const tx = s.transcript
        .map((m) => `${m.who === 'fan' ? 'FAN' : 'CREATOR'}: ${m.text}${m.ppvNote ? ` [${m.ppvNote}]` : ''}`)
        .join('\n');
      return `=== Set ${i + 1} (avg ${s.scoreObj?.avg ?? '?'}) ===
scores: ${JSON.stringify(s.scoreObj?.scores ?? {})}
ppv_unlocked: ${s.scoreObj?.ppv_unlocked ?? '?'}
top_issue: ${s.scoreObj?.top_issue ?? '?'}
fix_recommendation: ${s.scoreObj?.fix_recommendation ?? '?'}
transcript:
${tx}`;
    })
    .join('\n\n');

  const avg =
    sets.reduce((acc, s) => acc + (s.scoreObj?.avg ?? 0), 0) / Math.max(1, sets.length);

  const userPayload = `ARCHETYPE: ${archetype.id} — ${archetype.profile}
AGGREGATE AVG ACROSS 3 SETS: ${avg.toFixed(2)}

${setsBlock}

CURRENT PROMPT LAYERS:

=== identity (backend/personas/default/identity.md) ===
${fileContents.identity}

=== humanness (backend/src/prompt/layers/humanness.ts) ===
${fileContents.humanness}

=== task (backend/src/prompt/layers/task.ts) ===
${fileContents.task}

Identify the systemic failure across these 3 runs. Return JSON.`;
  const out = await grokChat({
    system: DEV_SYSTEM,
    messages: [{ role: 'user', content: userPayload }],
    temperature: 0.3,
    json: true,
  });
  try {
    return JSON.parse(out);
  } catch {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`dev non-JSON: ${out.slice(0, 200)}`);
  }
}

// ---- file edit + safety check ------------------------------------------

async function applyEdit(proposal) {
  const target = EDITABLE[proposal.file];
  if (!target) throw new Error(`unknown file: ${proposal.file}`);
  const { old_string, new_string } = proposal.edit;
  if (!old_string || typeof old_string !== 'string') {
    throw new Error('proposal missing old_string');
  }
  // Race-proof: re-read the file RIGHT before apply. Parallel-propose means
  // multiple dev agents read the same snapshot at Phase 2 start, but by the
  // time the 3rd/4th proposal applies, the file has shifted from earlier
  // applies. We retry once on old_string-not-found in case the target text
  // is still present but slightly shifted.
  const before = await fs.readFile(target, 'utf8');
  const occurrences = before.split(old_string).length - 1;
  if (occurrences === 0) {
    throw new Error('old_string not found (possibly shifted by a prior parallel edit — dev agent should scope non-overlapping regions)');
  }
  if (occurrences > 1) throw new Error(`old_string appears ${occurrences}x (must be unique)`);

  const after = before.replace(old_string, new_string);
  await fs.writeFile(target, after);

  // Wait for tsx watch to reload (TS files) and verify backend health. The
  // health probe might transiently throw (fetch fails) during reload — give
  // it a few attempts before deciding the edit broke things.
  let healthy = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(2000);
    try {
      healthy = await api.health();
    } catch {
      healthy = false;
    }
    if (healthy) break;
  }
  if (!healthy) {
    await fs.writeFile(target, before);
    await sleep(3000);
    return { applied: false, reason: 'backend health failed after edit — reverted' };
  }
  return { applied: true };
}

// ---- one conversation --------------------------------------------------

async function runConversation(arch, setN, workerId = null) {
  const start = Date.now();
  // Stable archetypes (longtime_vip) use a pre-seeded persistent fan so we
  // can test how the bot handles a known repeat customer with purchase
  // history. Cleanup pattern intentionally skips the "longtime-" prefix.
  // Other archetypes get a fresh fanId per set with worker+entropy so 5
  // parallel workers can't collide on external_id even if Date.now() ties.
  const fanId = arch.stable
    ? `longtime-${arch.id}-set${setN}`
    : `loop-${arch.id}-set${setN}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const tag = workerId != null ? `[w${workerId}]` : ' ';
  await log(`${tag} ${arch.id}/set${setN} start | fan=${fanId}`);

  // Pre-flight: if the backend is dead, retry health a few times before
  // declaring the loop bust. Saves us from cascading "fetch failed" crashes.
  let backendUp = false;
  for (let i = 0; i < 10 && !backendUp; i++) {
    try {
      backendUp = await api.health();
    } catch {
      backendUp = false;
    }
    if (!backendUp) await sleep(2000);
  }
  if (!backendUp) throw new Error('backend not responding after 20s of retries');

  const transcript = []; // { who, text, ppvNote? }
  let convId = null;
  let lastSeenMsgId = null;

  const opener = await generateOpener(arch);
  await api.inject(fanId, opener, fanId);
  transcript.push({ who: 'fan', text: opener });

  for (let turn = 0; turn < MAX_CONV_TURNS; turn++) {
    if (!convId) {
      for (let i = 0; i < 8 && !convId; i++) {
        await sleep(700);
        convId = await findConversation(fanId).catch(() => null);
      }
      if (!convId) {
        await log(`  set ${setN} could not find conversation`);
        break;
      }
    }

    const reply = await waitForReply(convId, lastSeenMsgId);
    if (!reply) {
      await log(`  set ${setN} turn ${turn} no bot reply`);
      transcript.push({ who: 'creator', text: '(no reply within 60s)' });
      break;
    }
    lastSeenMsgId = reply.reply.id;

    if (reply.reply.kind === 'ppv') {
      const p = reply.reply.ppv ?? {};
      const price = (p.priceCents ?? 0) / 100;
      const buy = Math.random() < arch.buyProb;
      const tags = Array.isArray(p.tags) && p.tags.length ? ` tags=[${p.tags.join(',')}]` : '';
      const ppvNote = `PPV $${price} · ${p.assetTitle ?? '?'} · ${p.assetDescription ?? ''}${tags} · ${buy ? 'BUYING' : 'skipping'}`;
      transcript.push({ who: 'creator', text: reply.reply.text || '(no caption)', ppvNote });
      if (buy) {
        try {
          await api.buyPpv(convId, reply.reply.id);
          await sleep(1500);
        } catch (e) {
          await log(`  set ${setN} buy failed: ${e.message}`);
        }
      }
    } else {
      transcript.push({ who: 'creator', text: reply.reply.text || '(no text)' });
    }

    const fanReply = await generateReply(arch, transcript);
    if (fanReply.includes('<<END>>')) {
      await log(`  set ${setN} fan ended at turn ${turn + 1}`);
      break;
    }
    // Simulated fan typing/distraction delay BEFORE injecting next message.
    // Tests how the bot handles real fan pacing (some fans are slow).
    if (arch.fanReplyDelayMs && arch.fanReplyDelayMs > 0) {
      await sleep(arch.fanReplyDelayMs);
    }
    transcript.push({ who: 'fan', text: fanReply });
    await api.inject(fanId, fanReply, fanId);
  }

  // Pull authoritative final state from backend
  const finalDetail = convId ? await api.thread(convId).catch(() => null) : null;
  const finalMessages = finalDetail?.messages ?? [];

  let scoreObj = null;
  try {
    scoreObj = await scoreConversation(arch, finalMessages);
  } catch (e) {
    await log(`  set ${setN} scorer error: ${e.message}`);
  }

  return {
    setN,
    fanId,
    convId,
    transcript,
    finalMessages,
    scoreObj,
    durationMs: Date.now() - start,
  };
}

// ---- Phase 1: parallel pool of N testers --------------------------------
// Build a flat queue of {arch, setN} items, spawn N workers that drain it.
// Each worker runs one full conversation at a time. NO edits in this phase.

async function runPhase1Parallel(workerCount) {
  const queue = [];
  for (const arch of ARCHETYPES) {
    for (let setN = 1; setN <= SETS_PER_ARCHETYPE; setN++) {
      queue.push({ arch, setN });
    }
  }
  await log(`PHASE 1 (parallel): ${queue.length} conversations across ${workerCount} testers`);

  const buckets = new Map();
  for (const arch of ARCHETYPES) buckets.set(arch.id, []);

  const workers = Array.from({ length: workerCount }, (_, workerId) =>
    (async () => {
      while (true) {
        const item = queue.shift();
        if (!item) return;
        const { arch, setN } = item;
        try {
          const result = await runConversation(arch, setN, workerId);
          buckets.get(arch.id).push(result);
          await fs.writeFile(
            path.join(TX_DIR, `arch-${arch.id}-set${setN}.json`),
            JSON.stringify({ archetype: arch, ...result }, null, 2),
          );
          await log(
            `[w${workerId}] ${arch.id}/set${setN} done avg=${result.scoreObj?.avg ?? '?'} ppv=${result.scoreObj?.ppv_unlocked ?? '?'} dur=${Math.round(result.durationMs / 1000)}s`,
          );
        } catch (e) {
          await log(`[w${workerId}] ${arch.id}/set${setN} CRASHED: ${e.message}`);
          buckets.get(arch.id).push({
            setN,
            error: e.message,
            scoreObj: null,
            transcript: [],
            finalMessages: [],
          });
        }
      }
    })(),
  );

  await Promise.all(workers);

  // Build summary structure (sort sets by setN within each archetype).
  return ARCHETYPES.map((arch) => {
    const sets = (buckets.get(arch.id) || []).sort((a, b) => a.setN - b.setN);
    const validScores = sets.map((s) => s.scoreObj?.avg).filter((v) => typeof v === 'number');
    const avgAcrossSets =
      validScores.length > 0 ? validScores.reduce((a, b) => a + b, 0) / validScores.length : null;
    return { archetype: arch.id, sets, avgAcrossSets };
  });
}

// Phase 2 split into PROPOSE (parallelizable, pure Grok calls) and APPLY
// (serialized, because each apply triggers a tsx-watch backend reload).

async function proposeForArchetype(archResult, fileContentsAtPhaseStart) {
  const { archetype: archId, sets, avgAcrossSets } = archResult;
  const arch = ARCHETYPES.find((a) => a.id === archId);

  if (avgAcrossSets == null) {
    return { archetype: archId, skipped: true, reason: 'no valid scores' };
  }
  if (avgAcrossSets >= SCORE_BAR) {
    return { archetype: archId, skipped: true, reason: `avg ${avgAcrossSets.toFixed(2)} above bar` };
  }

  try {
    const proposal = await proposeEdit({ archetype: arch, sets, fileContents: fileContentsAtPhaseStart });
    if (proposal.skip) {
      return { archetype: archId, skipped: true, reason: proposal.reason };
    }
    return { archetype: archId, proposal };
  } catch (e) {
    return { archetype: archId, error: e.message };
  }
}

async function applyArchetypeProposal(item) {
  const { archetype: archId, proposal, skipped, reason, error } = item;
  if (skipped) {
    await log(`  ${archId}: SKIPPED edit (${reason})`);
    return { skipped: true, reason };
  }
  if (error) {
    await log(`  ${archId}: propose ERROR: ${error}`);
    return { applied: false, error };
  }
  try {
    const result = await applyEdit(proposal);
    await log(
      `  ${archId}: edit file=${proposal.file} applied=${result.applied} systemic="${(proposal.systemic_issue || '').slice(0, 100)}" ${result.reason || ''}`,
    );
    return { ...result, file: proposal.file, systemic: proposal.systemic_issue, rationale: proposal.rationale };
  } catch (e) {
    await log(`  ${archId}: apply ERROR: ${e.message}`);
    return { applied: false, error: e.message };
  }
}

// ---- main loop ----------------------------------------------------------

async function readEditable() {
  const out = {};
  for (const k of Object.keys(EDITABLE)) {
    out[k] = await fs.readFile(EDITABLE[k], 'utf8');
  }
  return out;
}

/**
 * Find the next available run number. Scans for existing transcripts.runN/
 * directories and picks max+1. Each run gets its OWN labeled folder + log +
 * summary + backup snapshot — no more unlabeled "current" folder.
 */
async function nextRunNumber() {
  const entries = await fs.readdir(STATE_DIR).catch(() => []);
  let max = 0;
  for (const name of entries) {
    const m = /^transcripts\.run(\d+)$/.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

async function main() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  // Compute per-run paths BEFORE writing anything. Every artifact gets a
  // .runN suffix so past runs stay clearly labeled and discoverable.
  RUN_N = await nextRunNumber();
  TX_DIR = path.join(STATE_DIR, `transcripts.run${RUN_N}`);
  RUN_LOG = path.join(STATE_DIR, `run.log.run${RUN_N}`);
  SUMMARY_PATH = path.join(STATE_DIR, `summary.json.run${RUN_N}`);
  BACKUP_DIR = path.join(STATE_DIR, `backup-run${RUN_N}`);

  await fs.mkdir(TX_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  await fs.writeFile(RUN_LOG, '');

  ENV = await loadEnv();
  ADMIN_BASE = `http://localhost:${ENV.ADMIN_PORT || 8787}`;
  ADMIN_TOKEN = ENV.ADMIN_TOKEN;
  GROK_KEY = ENV.GROK_API_KEY;
  GROK_BASE = ENV.GROK_API_BASE || 'https://api.x.ai/v1';
  GROK_MODEL = ENV.GROK_MODEL_GENERATOR || 'grok-4';
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN missing');
  if (!GROK_KEY) throw new Error('GROK_API_KEY missing');

  // Auto-snapshot the editable files BEFORE any dev-agent edits happen this
  // run. Lets the user revert this run cleanly with: cp backup-runN/* ...
  for (const [name, srcPath] of Object.entries(EDITABLE)) {
    const ext = path.extname(srcPath);
    await fs.copyFile(srcPath, path.join(BACKUP_DIR, `${name}${ext}`));
  }

  const ok = await api.health();
  if (!ok) throw new Error('backend not healthy');
  await log(
    `loop v3 start | RUN ${RUN_N} | archetypes=${ARCHETYPES.length} | sets/archetype=${SETS_PER_ARCHETYPE} | parallel testers=${PARALLEL_TESTERS} | model=${GROK_MODEL}`,
  );
  await log(`run artifacts → ${TX_DIR} | ${RUN_LOG} | ${SUMMARY_PATH} | ${BACKUP_DIR}`);

  const start = Date.now();
  const summary = { runN: RUN_N, phase: 'collecting', testers: PARALLEL_TESTERS, archetypes: [], edits: [] };

  // PHASE 1 — N testers drain a flat queue of all archetype/set work items.
  summary.archetypes = await runPhase1Parallel(PARALLEL_TESTERS);
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  for (const ar of summary.archetypes) {
    await log(`  archetype ${ar.archetype} aggregate avg=${ar.avgAcrossSets?.toFixed(2) ?? '?'}`);
  }

  const phase1Sec = Math.round((Date.now() - start) / 1000);
  await log(`PHASE 1 COMPLETE in ${phase1Sec}s — moving to review/edit`);

  // PHASE 2 — split: propose-in-parallel (pure Grok), apply-sequentially
  // (backend reload). Slashes Phase 2 from O(N) Grok latencies to O(1) for
  // the proposal step + N reloads for apply.
  summary.phase = 'editing';
  const phase2Start = Date.now();

  // Snapshot file contents ONCE before any apply, so all parallel proposers
  // see the same baseline (fair comparison; later applies stack on each other).
  const fileContentsSnapshot = await readEditable();
  await log(`PHASE 2: proposing edits in parallel for ${summary.archetypes.length} archetypes`);
  const proposals = await Promise.all(
    summary.archetypes.map((a) => proposeForArchetype(a, fileContentsSnapshot)),
  );
  for (const p of proposals) {
    if (p.skipped) await log(`  ${p.archetype}: proposal phase → skip (${p.reason})`);
    else if (p.error) await log(`  ${p.archetype}: proposal phase → error (${p.error})`);
    else await log(`  ${p.archetype}: proposal phase → ${p.proposal?.file} edit ready`);
  }
  await log(`PHASE 2 (propose) done in ${Math.round((Date.now() - phase2Start) / 1000)}s — applying sequentially`);

  for (const item of proposals) {
    const editResult = await applyArchetypeProposal(item);
    summary.edits.push({ archetype: item.archetype, ...editResult });
    await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  }

  summary.phase = 'done';
  await log(`LOOP COMPLETE (run ${RUN_N}) — ${summary.archetypes.length} archetypes, ${summary.edits.filter((e) => e.applied).length} edits applied, ${Math.round((Date.now() - start) / 1000)}s total`);
  await log(`artifacts: ${TX_DIR} | ${RUN_LOG} | ${SUMMARY_PATH}`);
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
