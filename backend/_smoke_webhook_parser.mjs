// Smoke test: run the 4 real OFAPI webhook samples through the parsing path
// and confirm each comes out with the right normalised fields. No backend
// server, no DB writes — just the adapter logic in isolation.
//
// Run:  PLATFORM_API_KEY=x PLATFORM_API_BASE=https://x.example DATABASE_URL=postgres://x ANALYTICS_DATABASE_URL=postgres://x REDIS_URL=redis://x ADMIN_TOKEN=x GROK_API_KEY=x node _smoke_webhook_parser.mjs

import { spawnSync } from 'node:child_process';

const samples = {
  'messages.received': {
    headers: { 'x-ofapi-idempotency-key': 'evt_4a2fdef45de38eddb6dcbbf2628db52f50501201' },
    body: {
      event: 'messages.received',
      account_id: 'acct_92f627efcaf946009d555c060e92dee6',
      payload: {
        text: '<p>Tell you to move your f…ing hand lol</p>',
        fromUser: { id: 277563143, name: 'Shockthemonkey', username: 'u277563143' },
        id: 9412973836340,
        createdAt: '2026-04-26T22:41:49+00:00',
        media: [],
      },
    },
  },
  'messages.ppv.unlocked': {
    headers: { 'x-ofapi-idempotency-key': 'evt_1490a78ee9379a0f0a373760f2deed6a9b3236e3' },
    body: {
      event: 'messages.ppv.unlocked',
      account_id: 'acct_5d32685ee72144e9a1fc1ce9bde8edc6',
      payload: {
        id: '108696536270',
        type: 'paided_message',
        createdAt: '2026-04-26T18:51:00+00:00',
        text: "has purchased your <a href='https://onlyfans.com/my/chats/chat/371729709?firstId=9410988514181'>message</a> for $10.00!",
        replacePairs: { '{NAME}': 'Hyler', '{AMOUNT}': '$10.00' },
        user_id: '464635149',
        user: { id: 371729709, name: 'Hyler', username: 'u371729709' },
      },
    },
  },
  'subscriptions.new': {
    headers: { 'x-ofapi-idempotency-key': 'evt_4103ce34b8b6e3b7dc946f7a56f6404fffc75e75' },
    body: {
      event: 'subscriptions.new',
      account_id: 'acct_25dbc481849f45e0bc15ca007c3f49fd',
      payload: {
        id: '108693453149',
        type: 'subscribed',
        createdAt: '2026-04-26T17:44:00+00:00',
        text: 'subscribed to your profile!',
        replacePairs: { '{PRICE}': 'free' },
        subType: 'new_subscriber',
        user_id: '94711974',
        user: { id: 405810012, name: 'Jonatham', username: 'u405810012' },
      },
    },
  },
  // No real tip sample provided — built from analogous structure to validate
  // the price parser handles tips.received the same way as ppv.unlocked.
  'tips.received': {
    headers: { 'x-ofapi-idempotency-key': 'evt_test_tip' },
    body: {
      event: 'tips.received',
      account_id: 'acct_5d32685ee72144e9a1fc1ce9bde8edc6',
      payload: {
        id: '108700000000',
        createdAt: '2026-04-26T20:00:00+00:00',
        text: 'tipped you $5.00!',
        replacePairs: { '{AMOUNT}': '$5.00' },
        user: { id: 999888777, name: 'TipperFan' },
      },
    },
  },
};

// Spin up the adapter directly. Need to set required env vars first (config
// validator will exit if anything is missing).
process.env.PLATFORM_MODE = process.env.PLATFORM_MODE ?? 'http';
process.env.PLATFORM_API_KEY = process.env.PLATFORM_API_KEY ?? 'smoke_test_key';
process.env.PLATFORM_API_BASE = process.env.PLATFORM_API_BASE ?? 'https://app.onlyfansapi.com';
process.env.SHADOW_MODE = 'true';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://smoke:smoke@localhost/smoke';
process.env.ANALYTICS_DATABASE_URL = process.env.ANALYTICS_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'smoke';
process.env.GROK_API_KEY = process.env.GROK_API_KEY ?? 'smoke';

// We use the parseWebhook METHOD without actually constructing the adapter
// — its constructor builds a real HTTP client which requires populated
// PLATFORM_API_KEY/BASE. parseWebhook itself is stateless (doesn't touch
// `this.http`) so calling via the prototype is safe.
const { HttpPlatformAdapter } = await import('./src/platform/impl/http/adapter.ts');
const adapter = { parseWebhook: HttpPlatformAdapter.prototype.parseWebhook.bind(null) };

let pass = 0, fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

for (const [label, sample] of Object.entries(samples)) {
  console.log(`\n=== ${label} ===`);
  const events = adapter.parseWebhook({
    rawBody: JSON.stringify(sample.body),
    headers: sample.headers,
  });
  if (events == null) {
    console.log(`  ✗ parseWebhook returned null`);
    fail++;
    continue;
  }
  if (events.length !== 1) {
    console.log(`  ✗ expected 1 event, got ${events.length}`);
    fail++;
    continue;
  }
  const ev = events[0];

  if (label === 'messages.received') {
    check('kind=message.received', ev.kind === 'message.received');
    check('account id', ev.platformAccountId === 'acct_92f627efcaf946009d555c060e92dee6');
    check('fan id from fromUser.id', ev.subscriberExternalId === '277563143');
    check('idempotency externalId', ev.externalId === 'evt_4a2fdef45de38eddb6dcbbf2628db52f50501201');
    check('text HTML stripped',
      ev.payload.text === 'Tell you to move your f…ing hand lol',
      `got "${ev.payload.text}"`);
  } else if (label === 'messages.ppv.unlocked') {
    check('kind=ppv.unlocked', ev.kind === 'ppv.unlocked');
    check('fan id from user.id (NOT user_id)',
      ev.subscriberExternalId === '371729709',
      `got "${ev.subscriberExternalId}"`);
    check('price parsed to 1000 cents',
      ev.payload.price_cents === 1000,
      `got ${ev.payload.price_cents}`);
    check('asset_ref extracted from firstId URL',
      ev.payload.asset_ref === '9410988514181',
      `got "${ev.payload.asset_ref}"`);
    check('idempotency externalId', ev.externalId === 'evt_1490a78ee9379a0f0a373760f2deed6a9b3236e3');
  } else if (label === 'subscriptions.new') {
    check('kind=subscription.started', ev.kind === 'subscription.started');
    check('fan id from user.id', ev.subscriberExternalId === '405810012');
    check('display_name extracted', ev.payload.display_name === 'Jonatham');
  } else if (label === 'tips.received') {
    check('kind=tip.received', ev.kind === 'tip.received');
    check('fan id from user.id', ev.subscriberExternalId === '999888777');
    check('amount_cents = 500',
      ev.payload.amount_cents === 500,
      `got ${ev.payload.amount_cents}`);
  }
}

console.log(`\n=== SUMMARY ===  pass=${pass}  fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
