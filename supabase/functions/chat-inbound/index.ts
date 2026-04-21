/**
 * chat-inbound — Supabase Edge Function
 *
 * Receives an inbound chat message from OnlyFansAPI (event: messages.received),
 * persists it to chat_messages, and enqueues a job for chat-worker to draft a reply.
 *
 * NO LLM work happens here — must return 200 fast.
 *
 * OnlyFansAPI webhook payload shape (messages.received):
 * {
 *   "event":      "messages.received",
 *   "account_id": "acct_XXXXXXXXXXXXXXX",
 *   "payload": {
 *     "id":        1234567890,          // OF message ID — used as idempotency key
 *     "text":      "<p>hey cutie</p>",  // HTML-wrapped plain text
 *     "fromUser":  { "id": 12345 },     // fan's OF user ID = chat_id
 *     "createdAt": "2025-09-02T21:02:18+00:00",
 *     "isSentByMe": false               // always false for messages.received
 *   }
 * }
 *
 * We also guard against messages.sent replays (isSentByMe=true) — we don't
 * want to auto-reply to our own outbound messages.
 *
 * Required Supabase secrets:
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ONLYFANS_WEBHOOK_SECRET   (optional but recommended)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { supabase, resolveCreator } from "../_shared/supabase.ts";

const WEBHOOK_SECRET = Deno.env.get("ONLYFANS_WEBHOOK_SECRET") ?? null;
const JSON_HEADERS = { "Content-Type": "application/json" };

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // ── Optional signature verification ──────────────────────────────
    if (WEBHOOK_SECRET) {
      const auth = req.headers.get("Authorization") ?? "";
      const sig  = req.headers.get("x-webhook-signature") ?? "";
      if (!auth.includes(WEBHOOK_SECRET) && sig !== WEBHOOK_SECRET) {
        return new Response(
          JSON.stringify({ error: "Invalid signature" }),
          { status: 401, headers: JSON_HEADERS },
        );
      }
    }

    const body = await req.json();
    const { event, account_id, event_id, payload } = body;

    if (!account_id || !payload) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: account_id, payload" }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    // Guard: skip our own outbound messages if this webhook fires for sent too
    if (payload.isSentByMe === true) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "isSentByMe" }),
        { headers: JSON_HEADERS },
      );
    }

    // Fan ID: OnlyFansAPI sends fromUser.id; fall back to chat_id, user_id, fan_id
    const fanId = Number(
      payload.fromUser?.id ??
      payload.chat_id ??
      payload.user_id ??
      payload.fan_id ??
      payload.user?.id,
    );

    // Text: OnlyFansAPI wraps text in <p>…</p>; strip tags for plain storage
    const rawText = String(payload.text ?? payload.content ?? "");
    const content = rawText.replace(/<[^>]*>/g, "").trim();

    if (!fanId || !content) {
      return new Response(
        JSON.stringify({ error: "Could not extract fan_id or message content from payload" }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    // ── Resolve creator ─────────────────────────────────────────────
    const mapping = await resolveCreator(account_id);
    if (!mapping) {
      return new Response(
        JSON.stringify({ error: `Unknown account_id: ${account_id}` }),
        { status: 404, headers: JSON_HEADERS },
      );
    }
    const { creator_uuid, onlyfans_account_id } = mapping;

    // ── Insert inbound message (idempotent on external_event_id) ────
    // Use OF message ID as the idempotency key; fall back to top-level event_id
    const externalEventId = payload.id
      ? `msg_${payload.id}`
      : (event_id ? String(event_id) : null);

    const insertRow = {
      creator_uuid,
      onlyfans_account_id,
      fan_id: fanId,
      direction: "in" as const,
      role: "user" as const,
      content,
      status: "received" as const,
      external_event_id: externalEventId,
      created_at: payload.createdAt ?? payload.received_at ?? new Date().toISOString(),
    };

    const { data: inserted, error: insErr } = await supabase
      .from("chat_messages")
      .upsert(insertRow, {
        onConflict: "external_event_id",
        ignoreDuplicates: true,
      })
      .select("id")
      .maybeSingle();

    if (insErr) throw insErr;

    // If ignoreDuplicates swallowed the row, it's a replay — don't enqueue again
    if (!inserted) {
      return new Response(
        JSON.stringify({ ok: true, duplicate: true, event_id: externalEventId }),
        { headers: JSON_HEADERS },
      );
    }

    // ── Enqueue respond job ────────────────────────────────────────
    const { error: jobErr } = await supabase
      .from("chat_jobs")
      .insert({
        kind: "respond",
        payload: {
          message_id: inserted.id,
          creator_uuid,
          fan_id: fanId,
          onlyfans_account_id,
        },
      });

    if (jobErr) throw jobErr;

    return new Response(
      JSON.stringify({
        ok: true,
        event: event ?? "messages.received",
        message_id: inserted.id,
        creator_uuid,
        fan_id: fanId,
      }),
      { headers: JSON_HEADERS },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal Server Error";
    console.error("[chat-inbound] Error:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
});
