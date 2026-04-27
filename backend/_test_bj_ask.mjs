// Quick probe: build rapport past the rapport gate, then ask for BJ content.
// Verify the picker returns a BJ-relevant asset (Script 1 rung 4 "doing bj on a
// rooftop" OR a sucking-related rung via synonym expansion).
import fs from 'node:fs/promises';

const env = {};
for (const line of (await fs.readFile('.env.local','utf8')).split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim()); if (m) env[m[1]]=m[2];
}
const BASE = `http://localhost:${env.ADMIN_PORT || 8787}`;
const TOKEN = env.ADMIN_TOKEN;
const TEST_ACCOUNT_ID = '00000000-0000-0000-0000-00000000beef';

async function call(p, init={}) {
  const r = await fetch(`${BASE}${p}`,{...init,headers:{'content-type':'application/json',authorization:`Bearer ${TOKEN}`,...(init.headers||{})}});
  if (!r.ok) throw new Error(`${p} ${r.status}: ${await r.text().catch(()=>'')}`);
  return r.json();
}

const fanId = 'bj-probe-'+Date.now().toString(36);
const msgs = [
  "hey babe",
  "how u been",
  "im chillin, u?",
  "long day of meetings fr",
  "you got any bj content?",
];

console.log('inject opener');
await call('/admin/test/inject',{method:'POST',body:JSON.stringify({subscriberExternalId:fanId,subscriberName:fanId,text:msgs[0],accountId:TEST_ACCOUNT_ID})});

let convId = null;
for (let i=0; i<20 && !convId; i++) {
  await new Promise(r=>setTimeout(r,500));
  const t=await call('/admin/threads'); convId = t.threads.find(x=>x.subscriberExternalId===fanId)?.conversationId ?? null;
}

let lastId=null;
async function waitOut(){
  for (let i=0;i<60;i++){
    await new Promise(r=>setTimeout(r,1000));
    const d=await call(`/admin/threads/${convId}`);
    const out=(d.messages||[]).filter(m=>m.direction==='outbound');
    const idx=lastId?out.findIndex(m=>m.id===lastId):-1;
    const newOut=out.slice(idx+1)[0];
    if (newOut){ lastId=newOut.id; return newOut; }
  }
  return null;
}

for (let turn=1; turn<msgs.length; turn++){
  const reply = await waitOut();
  if (!reply){ console.log('timeout');break; }
  const ppv = reply.kind==='ppv' ? ` [PPV $${(reply.ppv?.priceCents??0)/100} — ${reply.ppv?.assetTitle} | ${reply.ppv?.assetDescription}]` : '';
  console.log(`BOT: ${(reply.text||'').slice(0,150)}${ppv}`);
  console.log(`FAN: ${msgs[turn]}`);
  await call('/admin/test/inject',{method:'POST',body:JSON.stringify({subscriberExternalId:fanId,subscriberName:fanId,text:msgs[turn],accountId:TEST_ACCOUNT_ID})});
}
// Wait for final reply to the BJ ask
const finalReply = await waitOut();
if (finalReply) {
  const ppv = finalReply.kind==='ppv' ? ` [PPV $${(finalReply.ppv?.priceCents??0)/100} — ${finalReply.ppv?.assetTitle} | ${finalReply.ppv?.assetDescription}]` : '';
  console.log(`\n>>> FINAL REPLY TO BJ ASK: ${finalReply.text}${ppv}`);
}
