/**
 * chat-worker — Supabase Edge Function
 *
 * Invoked every 10s by pg_cron. Claims up to BATCH_SIZE pending chat_jobs
 * via FOR UPDATE SKIP LOCKED (simulated through an RPC or row-level lock),
 * then for each 'respond' job:
 *
 *   1. Load context: recent messages + summary + live facts (L1/L2/L3).
 *   2. Classify the inbound message (grok-3-mini, JSON mode).
 *      → {mood, intent, confidence, should_respond}
 *   3. If should_respond=false: mark original message status='suppressed'
 *      and finish the job. No reply is drafted.
 *   4. Otherwise pick a routing template by (mood × intent), call grok-4
 *      to generate the reply, and INSERT a new chat_messages row with
 *      status='drafted'. Phase 1 does NOT send — the sender is Phase 2.
 *   5. Also classify the inbound message row (write mood/intent/conf).
 *   6. Mark job done; on error, increment attempts and requeue until 5.
 *
 * Required Supabase secrets:
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GROK_API_KEY
 *   GROK_MODEL_GENERATOR   (default: 'grok-4')
 *   GROK_MODEL_CLASSIFIER  (default: 'grok-3-mini')
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { supabase } from "../_shared/supabase.ts";
import { grokChat } from "../_shared/grok.ts";
import { PERSONA_GIRLFRIEND_NEXT_DOOR } from "../_shared/persona.ts";
import { pickTemplate } from "../_shared/templates.ts";
import { buildContext, renderContextBlock } from "../_shared/context.ts";
import type { ClassifierOutput, Mood, Intent, ChatMessageRow } from "../_shared/types.ts";

const GENERATOR_MODEL  = Deno.env.get("GROK_MODEL_GENERATOR")  ?? "grok-4";
const CLASSIFIER_MODEL = Deno.env.get("GROK_MODEL_CLASSIFIER") ?? "grok-3-mini";

const BATCH_SIZE   = 10;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 2;
const BACKOFF_SECONDS = [10, 30, 120, 300, 600];  // per-attempt requeue delay

const JSON_HEADERS = { "Content-Type": "application/json" };

const MOODS: Mood[] = ["horny", "lonely", "chatty", "aggressive", "hesitant"];
const INTENTS: Intent[] = [
  "just_talking",
  "demanding_free_content",
  "ready_to_buy",
  "complaining",
];

// ── Job claim ──────────────────────────────────────────────────────
/**
 * Claim up to BATCH_SIZE pending jobs by updating their locked_until
 * timestamp. This is the Edge-function-friendly stand-in for
 * `FOR UPDATE SKIP LOCKED` (Supabase REST doesn't expose that directly).
 * A job is considered claimable if status='pending' AND run_after<=now()
 * AND (locked_until IS NULL OR locked_until<=now()).
 */
async function claimJobs(): Promise<{ id: number; kind: string; payload: Record<string, unknown>; attempts: number }[]> {
  const nowISO = new Date().toISOString();
  const newLock = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();

  // Get candidates (fetch all pending and filter in memory to avoid PostgREST .or() parsing bugs with ISO strings)
  const { data: pending, error: selErr } = await supabase
    .from("chat_jobs")
    .select("id, run_after, locked_until")
    .eq("status", "pending")
    .order("run_after", { ascending: true })
    .limit(BATCH_SIZE * 5); // Fetch a few extra to account for locked ones

  if (selErr) throw selErr;
  if (!pending || pending.length === 0) return [];

  // Filter in memory for run_after <= now and (locked_until == null || locked_until <= now)
  const candidates = pending.filter((j) => {
    if (j.run_after > nowISO) return false;
    if (j.locked_until === null) return true;
    return j.locked_until <= nowISO;
  });

  if (candidates.length === 0) return [];
  const ids = candidates.slice(0, BATCH_SIZE).map((r) => r.id);

  // Lock them
  const { data: locked, error: lockErr } = await supabase
    .from("chat_jobs")
    .update({ locked_until: newLock, updated_at: nowISO })
    .in("id", ids)
    .select("id, kind, payload, attempts");

  if (lockErr) throw lockErr;
  return (locked ?? []) as { id: number; kind: string; payload: Record<string, unknown>; attempts: number }[];
}

async function markJobDone(id: number) {
  await supabase
    .from("chat_jobs")
    .update({ status: "done", updated_at: new Date().toISOString() })
    .eq("id", id);
}

async function markJobFailure(id: number, attempts: number, errMsg: string) {
  const nextAttempt = attempts + 1;
  const finalFailure = nextAttempt >= MAX_ATTEMPTS;
  const delay = BACKOFF_SECONDS[Math.min(nextAttempt, BACKOFF_SECONDS.length - 1)];
  const runAfter = new Date(Date.now() + delay * 1000).toISOString();

  await supabase
    .from("chat_jobs")
    .update({
      status:       finalFailure ? "failed" : "pending",
      attempts:     nextAttempt,
      last_error:   errMsg.slice(0, 1000),
      locked_until: null,
      run_after:    finalFailure ? undefined : runAfter,
      updated_at:   new Date().toISOString(),
    })
    .eq("id", id);
}

// ── Classifier ─────────────────────────────────────────────────────
const CLASSIFIER_SYSTEM = `
You classify incoming chat messages sent by fans to a model on OnlyFans.
Respond with ONLY a compact JSON object matching this schema:
{
  "mood":    "horny" | "lonely" | "chatty" | "aggressive" | "hesitant",
  "intent":  "just_talking" | "demanding_free_content" | "ready_to_buy" | "complaining",
  "confidence":     0.0..1.0,
  "should_respond": true | false
}
Rules:
- should_respond=false ONLY for clear goodbyes, empty/one-letter fragments,
  or messages that are not conversational (e.g. a sticker ack, "k", "ok bye").
- "ready_to_buy" means they're leaning in sexually OR explicitly asking for
  content, NOT just polite interest.
- "demanding_free_content" means they're asking for free pics/videos or
  refusing to pay.
- If ambiguous, prefer mood=chatty, intent=just_talking with lower confidence.
Output JSON only. No prose.
`.trim();

async function classify(
  content: string,
  recentContext: string,
): Promise<ClassifierOutput> {
  const res = await grokChat({
    model: CLASSIFIER_MODEL,
    system: CLASSIFIER_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          (recentContext ? `Recent exchange:\n${recentContext}\n\n` : "") +
          `Fan just sent:\n"${content}"`,
      },
    ],
    json: true,
    temperature: 0.1,
    maxTokens: 120,
  });

  let parsed: Partial<ClassifierOutput> = {};
  try {
    parsed = JSON.parse(res.content);
  } catch {
    // fall through to defaults
  }

  const mood   = MOODS.includes(parsed.mood as Mood)     ? (parsed.mood as Mood)     : "chatty";
  const intent = INTENTS.includes(parsed.intent as Intent) ? (parsed.intent as Intent) : "just_talking";
  const confidence = clamp01(Number(parsed.confidence ?? 0.5));
  const should_respond = parsed.should_respond !== false;

  return { mood, intent, confidence, should_respond };
}

function clamp01(n: number): number {
  if (!isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// ── Job processor ──────────────────────────────────────────────────
async function processRespondJob(job: {
  id: number;
  payload: Record<string, unknown>;
}) {
  const messageId = Number(job.payload.message_id);
  const creatorUuid = String(job.payload.creator_uuid ?? "");
  const fanId = Number(job.payload.fan_id);
  const onlyfansAccountId = String(job.payload.onlyfans_account_id ?? "");

  if (!messageId || !creatorUuid || !fanId || !onlyfansAccountId) {
    throw new Error("respond job payload missing required fields");
  }

  // Check the subscriber's ai_paused flag — skip generation if paused
  const { data: sub } = await supabase
    .from("onlyfans_subscribers")
    .select("ai_paused")
    .eq("creator_uuid", creatorUuid)
    .eq("fan_id", fanId)
    .maybeSingle();
  if (sub?.ai_paused) {
    // Paused: don't draft. Mark the inbound as suppressed so the UI shows it.
    await supabase
      .from("chat_messages")
      .update({ status: "suppressed" })
      .eq("id", messageId);
    return;
  }

  // Load the original inbound row + context
  const { data: original, error: origErr } = await supabase
    .from("chat_messages")
    .select("id, content, created_at")
    .eq("id", messageId)
    .single();
  if (origErr) throw origErr;

  const ctx = await buildContext(creatorUuid, fanId);

  // Build a compact recent-exchange string for the classifier
  const recentStr = ctx.recent
    .slice(-6)
    .map((m) => `${m.direction === "in" ? "Fan" : "You"}: ${m.content}`)
    .join("\n");

  // 1. Classify
  const classification = await classify(original.content, recentStr);

  // Write classifier output back onto the inbound row
  await supabase
    .from("chat_messages")
    .update({
      mood: classification.mood,
      intent: classification.intent,
      classifier_conf: classification.confidence,
    })
    .eq("id", messageId);

  // 2. If the model says not to respond, mark suppressed and stop
  if (!classification.should_respond) {
    await supabase
      .from("chat_messages")
      .update({ status: "suppressed" })
      .eq("id", messageId);
    return;
  }

  // 3. Pick template + build generator prompt
  const template = pickTemplate(classification.mood, classification.intent);
  const contextBlock = renderContextBlock(ctx);

  const systemPrompt = [
    PERSONA_GIRLFRIEND_NEXT_DOOR,
    contextBlock,
    `Current read on this fan: mood=${classification.mood}, intent=${classification.intent}.`,
    template.system_suffix,
  ].filter(Boolean).join("\n\n");

  // Few-shots as synthetic user/assistant turns, then real recent history, then the inbound.
  const messages = [
    ...template.few_shots.flatMap((s) => [
      { role: "user" as const,      content: s.user },
      { role: "assistant" as const, content: s.assistant },
    ]),
    ...ctx.recent.map((m: ChatMessageRow) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  // 4. Generate
  const gen = await grokChat({
    model: GENERATOR_MODEL,
    system: systemPrompt,
    messages,
    temperature: 0.95,
    maxTokens: 200,
  });

  const reply = gen.content.trim();

  // 5. Persist draft (no send in Phase 1)
  const { error: draftErr } = await supabase
    .from("chat_messages")
    .insert({
      creator_uuid: creatorUuid,
      onlyfans_account_id: onlyfansAccountId,
      fan_id: fanId,
      direction: "out",
      role: "assistant",
      content: reply,
      status: "drafted",
      mood: classification.mood,
      intent: classification.intent,
      classifier_conf: classification.confidence,
      model_used: gen.model,
      prompt_tokens: gen.usage.prompt,
      completion_tokens: gen.usage.completion,
    });
  if (draftErr) throw draftErr;

  // 6. Update subscriber's last_ai_reply_at
  await supabase
    .from("onlyfans_subscribers")
    .update({ last_ai_reply_at: new Date().toISOString() })
    .eq("creator_uuid", creatorUuid)
    .eq("fan_id", fanId);
}

// ── HTTP entrypoint ────────────────────────────────────────────────
serve(async (_req: Request) => {
  try {
    const jobs = await claimJobs();
    if (jobs.length === 0) {
      return new Response(JSON.stringify({ ok: true, claimed: 0 }), { headers: JSON_HEADERS });
    }

    const results: Array<{ id: number; status: string; error?: string }> = [];

    // Process sequentially — keeps Grok rate limits predictable. Revisit if batches get big.
    for (const job of jobs) {
      try {
        if (job.kind === "respond") {
          await processRespondJob(job);
        } else {
          // Unknown kind — mark done so it doesn't loop forever
          console.warn(`[chat-worker] unknown job kind: ${job.kind}`);
        }
        await markJobDone(job.id);
        results.push({ id: job.id, status: "done" });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[chat-worker] job ${job.id} failed:`, msg);
        await markJobFailure(job.id, job.attempts ?? 0, msg);
        results.push({ id: job.id, status: "error", error: msg });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, claimed: jobs.length, results }),
      { headers: JSON_HEADERS },
    );
  } catch (err: any) {
    const msg = err?.message || err?.details || String(err) || "Internal Server Error";
    console.error("[chat-worker] fatal:", msg, err);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
});
