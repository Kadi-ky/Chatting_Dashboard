/**
 * income-webhook — Supabase Edge Function
 *
 * Receives OnlyFansAPI webhook events for tips and subscriptions
 * and stores them in the appropriate tables for dashboard display.
 *
 * Handled events:
 *   tips.received          → tips_onlyfans
 *   subscriptions.new      → subscriptions_income_onlyfans (event_type = 'new')
 *   subscriptions.renewed  → subscriptions_income_onlyfans (event_type = 'renewed')
 *
 * Webhook URL:
 *   https://<project-ref>.supabase.co/functions/v1/income-webhook
 *
 * Required Supabase secrets (set via `supabase secrets set`):
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ONLYFANS_WEBHOOK_SECRET   (optional — recommended for security)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL             = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET           = Deno.env.get("ONLYFANS_WEBHOOK_SECRET") ?? null;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Parse a price string like "$4.00" or "free" → number */
function parsePrice(priceStr: string | undefined): number {
  if (!priceStr || priceStr.trim().toLowerCase() === "free") return 0;
  const num = parseFloat(priceStr.replace(/[^0-9.]/g, ""));
  return isNaN(num) ? 0 : num;
}

/** Resolve creator_uuid from the account_id field in the webhook payload */
async function resolveCreator(accountId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("creator_onlyfans_accounts")
    .select("creator_uuid")
    .eq("onlyfans_account_id", accountId)
    .eq("is_active", true)
    .single();
  return error || !data ? null : data.creator_uuid;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // ── Optional webhook secret verification ──────────────────────────
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
    const { event, account_id, payload } = body;

    if (!event || !account_id || !payload) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: event, account_id, payload" }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    // ── Resolve creator ───────────────────────────────────────────────
    const creatorUuid = await resolveCreator(account_id);
    if (!creatorUuid) {
      return new Response(
        JSON.stringify({ error: `Unknown account_id: ${account_id}` }),
        { status: 404, headers: JSON_HEADERS },
      );
    }

    // ── tips.received ─────────────────────────────────────────────────
    if (event === "tips.received") {
      const eventId = String(payload.id ?? "");
      if (!eventId) {
        return new Response(
          JSON.stringify({ error: "payload.id is required" }),
          { status: 400, headers: JSON_HEADERS },
        );
      }

      const { error: insErr } = await supabase
        .from("tips_onlyfans")
        .upsert(
          {
            event_id:     eventId,
            creator_uuid: creatorUuid,
            fan_user_id:  String(payload.user_id ?? payload.user?.id ?? ""),
            fan_name:     payload.user?.name     ?? null,
            fan_username: payload.user?.username ?? null,
            amount_gross: Number(payload.amountGross) || 0,
            amount_net:   Number(payload.amountNet)   || 0,
            tipped_at:    payload.createdAt,
          },
          { onConflict: "event_id", ignoreDuplicates: true },
        );

      if (insErr) throw insErr;
      return new Response(JSON.stringify({ ok: true, event }), { headers: JSON_HEADERS });
    }

    // ── subscriptions.new / subscriptions.renewed ─────────────────────
    if (event === "subscriptions.new" || event === "subscriptions.renewed") {
      const eventId = String(payload.id ?? "");
      if (!eventId) {
        return new Response(
          JSON.stringify({ error: "payload.id is required" }),
          { status: 400, headers: JSON_HEADERS },
        );
      }

      const priceStr  = payload.replacePairs?.["{PRICE}"] ?? "";
      const amount    = parsePrice(priceStr);
      const eventType = event === "subscriptions.new" ? "new" : "renewed";

      const { error: insErr } = await supabase
        .from("subscriptions_income_onlyfans")
        .upsert(
          {
            event_id:      eventId,
            creator_uuid:  creatorUuid,
            event_type:    eventType,
            sub_type:      payload.subType      ?? null,
            fan_user_id:   String(payload.user_id ?? payload.user?.id ?? ""),
            fan_name:      payload.user?.name    ?? null,
            fan_username:  payload.user?.username ?? null,
            amount,
            subscribed_at: payload.createdAt,
          },
          { onConflict: "event_id", ignoreDuplicates: true },
        );

      if (insErr) throw insErr;
      return new Response(JSON.stringify({ ok: true, event }), { headers: JSON_HEADERS });
    }

    // ── Unrecognised event — acknowledge silently ─────────────────────
    return new Response(
      JSON.stringify({ ok: true, skipped: `unhandled event: ${event}` }),
      { headers: JSON_HEADERS },
    );

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal Server Error";
    console.error("[income-webhook] Error:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
});
