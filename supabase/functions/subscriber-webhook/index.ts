/**
 * subscriber-webhook — Supabase Edge Function
 *
 * Receives OnlyFansAPI webhook events and incrementally updates
 * onlyfans_subscribers so the dashboard stays near real-time
 * without re-fetching the full roster.
 *
 * Expected webhook payload shape (adapt field names to your
 * actual OnlyFansAPI webhook docs):
 * {
 *   "event": "fan.subscribe" | "fan.renew" | "fan.expire" | "fan.cancel",
 *   "account_id": "acct_XXXXXXXXXXXXXXX",
 *   "data": {
 *     "id": 123,                      // fan id
 *     "name": "...",
 *     "username": "...",
 *     "avatar": "...",
 *     "subscribePrice": 4.99,
 *     "subscribedOnData": { ... },     // same shape as List Active Fans
 *     "lastSeen": "...",
 *     ...
 *   },
 *   "event_id": "evt_xxx",            // for idempotency
 *   "timestamp": "2026-03-22T00:00:00Z"
 * }
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("ONLYFANS_WEBHOOK_SECRET") || null;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Events that mean the subscriber is active
const ACTIVE_EVENTS = new Set(["fan.subscribe", "fan.renew"]);
// Events that mean the subscriber is no longer active
const INACTIVE_EVENTS = new Set(["fan.expire", "fan.cancel"]);

serve(async (req: Request) => {
  // Only accept POST
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // Optional: verify webhook signature
    if (WEBHOOK_SECRET) {
      const sig = req.headers.get("x-webhook-signature") || "";
      // If your provider supports HMAC verification, validate here.
      // For now we just check the secret is present as a bearer token.
      if (sig !== WEBHOOK_SECRET) {
        const authHeader = req.headers.get("Authorization") || "";
        if (!authHeader.includes(WEBHOOK_SECRET)) {
          return new Response(
            JSON.stringify({ error: "Invalid signature" }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
      }
    }

    const body = await req.json();
    const { event, account_id, data, event_id } = body;

    if (!event || !account_id || !data?.id) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: event, account_id, data.id" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Resolve creator_uuid from account mapping
    const { data: mapping, error: mapErr } = await supabase
      .from("creator_onlyfans_accounts")
      .select("creator_uuid")
      .eq("onlyfans_account_id", account_id)
      .eq("is_active", true)
      .single();

    if (mapErr || !mapping) {
      return new Response(
        JSON.stringify({ error: `Unknown account: ${account_id}` }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    const creatorUuid = mapping.creator_uuid;
    const now = new Date().toISOString();
    const subData = data.subscribedOnData;
    const currentSub = subData?.subscribes?.find((s: any) => s.isCurrent);

    if (ACTIVE_EVENTS.has(event)) {
      // Subscriber became active — upsert
      const row = {
        creator_uuid: creatorUuid,
        onlyfans_account_id: account_id,
        fan_id: data.id,
        name: data.name || data.displayName || null,
        username: data.username || null,
        avatar: data.avatarThumbs?.c144 || data.avatar || null,
        is_active: true,
        subscribed_on: currentSub?.startDate || subData?.subscribeAt || null,
        expires_at: currentSub?.expireDate || subData?.expiredAt || null,
        subscribe_price: data.subscribePrice ?? null,
        total_spent: subData?.totalSumm ?? 0,
        last_seen_at: data.lastSeen || null,
        subscription_status: subData?.status || "active",
        last_source: "webhook",
        updated_at: now,
      };

      const { error: upsertErr } = await supabase
        .from("onlyfans_subscribers")
        .upsert(row, { onConflict: "creator_uuid,fan_id" });

      if (upsertErr) throw upsertErr;
    } else if (INACTIVE_EVENTS.has(event)) {
      // Subscriber became inactive — update existing row
      const { error: updateErr } = await supabase
        .from("onlyfans_subscribers")
        .update({
          is_active: false,
          subscription_status: event === "fan.expire" ? "expired" : "cancelled",
          last_source: "webhook",
          updated_at: now,
        })
        .eq("creator_uuid", creatorUuid)
        .eq("fan_id", data.id);

      if (updateErr) throw updateErr;
    } else {
      // Unknown event type — log but don't fail
      console.warn(`Unknown webhook event: ${event}`);
    }

    return new Response(
      JSON.stringify({ ok: true, event, fan_id: data.id, creator_uuid: creatorUuid }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("Webhook error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
