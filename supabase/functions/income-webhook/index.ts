/**
 * income-webhook — Supabase Edge Function
 *
 * Receives OnlyFansAPI webhook events for tips and subscriptions
 * and stores them in the appropriate tables for dashboard display.
 *
 * Also updates onlyfans_subscribers in real-time when a new
 * subscription is received (by fetching the fan's subscription
 * history from the API for the expiry date).
 *
 * Handled events:
 *   tips.received          → tips_onlyfans
 *   subscriptions.new      → subscriptions_income_onlyfans + onlyfans_subscribers
 *   messages.ppv.unlocked  → (acknowledged, no storage yet)
 *
 * Note: OnlyFansAPI does NOT have fan.expire / fan.cancel / subscriptions.renewed
 *       webhook events. Expiration is handled by the daily subscriber-reset cron.
 *
 * Webhook URL:
 *   https://<project-ref>.supabase.co/functions/v1/income-webhook
 *
 * Required Supabase secrets:
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ONLYFANS_API_KEY
 *   ONLYFANS_WEBHOOK_SECRET   (optional — recommended for security)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL             = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET           = Deno.env.get("ONLYFANS_WEBHOOK_SECRET") ?? null;
const ONLYFANS_API_KEY         = Deno.env.get("ONLYFANS_API_KEY")!;
const ONLYFANS_API_BASE        = "https://app.onlyfansapi.com/api";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Parse a price string like "$4.00" or "free" → number */
function parsePrice(priceStr: string | undefined): number {
  if (!priceStr || priceStr.trim().toLowerCase() === "free") return 0;
  const num = parseFloat(priceStr.replace(/[^0-9.]/g, ""));
  return isNaN(num) ? 0 : num;
}

/** Resolve creator_uuid + onlyfans_account_id from the webhook account_id */
async function resolveCreator(accountId: string): Promise<{ creator_uuid: string; onlyfans_account_id: string } | null> {
  const { data, error } = await supabase
    .from("creator_onlyfans_accounts")
    .select("creator_uuid, onlyfans_account_id")
    .eq("onlyfans_account_id", accountId)
    .eq("is_active", true)
    .single();
  return error || !data ? null : data;
}

/** Fetch the fan's latest subscription expiry from OnlyFansAPI */
async function fetchSubscriptionExpiry(
  accountId: string,
  userId: string,
): Promise<{ subscribeDate: string | null; expireDate: string | null; price: number }> {
  try {
    const url = `${ONLYFANS_API_BASE}/${accountId}/fans/${userId}/subscriptions-history`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ONLYFANS_API_KEY}` },
    });
    if (!res.ok) return { subscribeDate: null, expireDate: null, price: 0 };
    const json = await res.json();
    const list = json?.data?.list ?? [];
    if (list.length === 0) return { subscribeDate: null, expireDate: null, price: 0 };
    // The last entry in the list is the most recent subscription
    const latest = list[list.length - 1];
    return {
      subscribeDate: latest.subscribeDate ?? null,
      expireDate: latest.expireDate ?? null,
      price: Number(latest.price) || 0,
    };
  } catch {
    return { subscribeDate: null, expireDate: null, price: 0 };
  }
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
    const mapping = await resolveCreator(account_id);
    if (!mapping) {
      return new Response(
        JSON.stringify({ error: `Unknown account_id: ${account_id}` }),
        { status: 404, headers: JSON_HEADERS },
      );
    }
    const { creator_uuid: creatorUuid, onlyfans_account_id } = mapping;

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

    // ── subscriptions.new ────────────────────────────────────────────
    // Note: OnlyFansAPI only has subscriptions.new (no .renewed / .expired)
    if (event === "subscriptions.new") {
      const eventId = String(payload.id ?? "");
      if (!eventId) {
        return new Response(
          JSON.stringify({ error: "payload.id is required" }),
          { status: 400, headers: JSON_HEADERS },
        );
      }

      const fanUserId = String(payload.user_id ?? payload.user?.id ?? "");
      const fanName   = payload.user?.name     ?? null;
      const fanUsername = payload.user?.username ?? null;
      const priceStr  = payload.replacePairs?.["{PRICE}"] ?? "";
      const amount    = parsePrice(priceStr);

      // 1. Record subscription income
      const { error: insErr } = await supabase
        .from("subscriptions_income_onlyfans")
        .upsert(
          {
            event_id:      eventId,
            creator_uuid:  creatorUuid,
            event_type:    "new",
            sub_type:      payload.subType      ?? null,
            fan_user_id:   fanUserId,
            fan_name:      fanName,
            fan_username:  fanUsername,
            amount,
            subscribed_at: payload.createdAt,
          },
          { onConflict: "event_id", ignoreDuplicates: true },
        );

      if (insErr) throw insErr;

      // 2. Fetch subscription history from OnlyFansAPI to get expiry date
      //    then upsert subscriber as active
      if (fanUserId) {
        const subHistory = await fetchSubscriptionExpiry(onlyfans_account_id, fanUserId);
        const now = new Date().toISOString();

        const { error: subErr } = await supabase
          .from("onlyfans_subscribers")
          .upsert(
            {
              creator_uuid:  creatorUuid,
              onlyfans_account_id,
              fan_id:        Number(fanUserId) || 0,
              name:          fanName,
              username:      fanUsername,
              is_active:     true,
              subscribed_on: subHistory.subscribeDate,
              expires_at:    subHistory.expireDate,
              subscribe_price: subHistory.price || amount,
              subscription_status: "active",
              last_source:   "webhook",
              updated_at:    now,
            },
            { onConflict: "creator_uuid,fan_id" },
          );

        if (subErr) {
          // Log but don't fail the whole webhook — income was already recorded
          console.error("[income-webhook] Subscriber upsert error:", subErr.message);
        }
      }

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
