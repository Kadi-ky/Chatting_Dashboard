/**
 * subscriber-reset — Supabase Edge Function
 *
 * Runs once per day (via cron or manual invoke).
 * For each active creator-account mapping:
 *   1. Fetches ALL active fans from OnlyFansAPI (paginated).
 *   2. Upserts them into onlyfans_subscribers.
 *   3. Marks any subscribers NOT returned by the API as inactive.
 *   4. Logs the run in onlyfans_subscriber_sync_runs.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ONLYFANS_API_KEY = Deno.env.get("ONLYFANS_API_KEY")!;
const ONLYFANS_API_BASE = "https://app.onlyfansapi.com/api";
const PAGE_SIZE = 20; // max allowed by OnlyFansAPI
const MAX_PAGES = 500; // safety cap

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Helpers ──────────────────────────────────────────────

async function fetchActiveFans(
  accountId: string,
): Promise<{ fans: any[]; pageCount: number }> {
  const fans: any[] = [];
  let offset = 0;
  let pageCount = 0;
  let hasMore = true;

  while (hasMore && pageCount < MAX_PAGES) {
    const url = `${ONLYFANS_API_BASE}/${accountId}/fans/active?limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ONLYFANS_API_KEY}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OnlyFansAPI ${res.status}: ${text}`);
    }

    const json = await res.json();
    const list = json?.data?.list ?? [];
    fans.push(...list);
    pageCount++;

    hasMore = json?.data?.hasMore === true;
    offset += PAGE_SIZE;

    // Respect rate limits — small delay between pages
    if (hasMore) await new Promise((r) => setTimeout(r, 200));
  }

  return { fans, pageCount };
}

function normalizeFan(
  fan: any,
  creatorUuid: string,
  accountId: string,
  resetAt: string,
) {
  const subData = fan.subscribedOnData;
  const currentSub = subData?.subscribes?.find((s: any) => s.isCurrent);

  return {
    creator_uuid: creatorUuid,
    onlyfans_account_id: accountId,
    fan_id: fan.id,
    name: fan.name || fan.displayName || null,
    username: fan.username || null,
    avatar: fan.avatarThumbs?.c144 || fan.avatar || null,
    is_active: true,
    subscribed_on: currentSub?.startDate || subData?.subscribeAt || null,
    expires_at: currentSub?.expireDate || subData?.expiredAt || null,
    subscribe_price: fan.subscribePrice ?? null,
    total_spent: subData?.totalSumm ?? 0,
    last_seen_at: fan.lastSeen || null,
    subscription_status: subData?.status || "active",
    last_source: "reset",
    last_reset_at: resetAt,
    updated_at: resetAt,
  };
}

// ── Main handler ─────────────────────────────────────────

serve(async (req: Request) => {
  try {
    // Verify the caller has a valid service-role or anon token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }

    // Fetch all active creator-account mappings
    const { data: creators, error: crErr } = await supabase
      .from("creator_onlyfans_accounts")
      .select("creator_uuid, creator_name, onlyfans_account_id")
      .eq("is_active", true);

    if (crErr) throw crErr;
    if (!creators || creators.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: "No active creators to sync" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const results: any[] = [];
    const resetAt = new Date().toISOString();

    for (const creator of creators) {
      const { creator_uuid, onlyfans_account_id } = creator;

      // Insert sync-run audit row
      const { data: runRow } = await supabase
        .from("onlyfans_subscriber_sync_runs")
        .insert({
          creator_uuid,
          started_at: resetAt,
          status: "running",
        })
        .select("id")
        .single();

      const runId = runRow?.id;

      try {
        // 1. Fetch all active fans
        const { fans, pageCount } = await fetchActiveFans(onlyfans_account_id);

        // 2. Upsert fans
        if (fans.length > 0) {
          const rows = fans.map((f) =>
            normalizeFan(f, creator_uuid, onlyfans_account_id, resetAt)
          );

          // Batch upsert in chunks of 500
          for (let i = 0; i < rows.length; i += 500) {
            const chunk = rows.slice(i, i + 500);
            const { error: upsertErr } = await supabase
              .from("onlyfans_subscribers")
              .upsert(chunk, { onConflict: "creator_uuid,fan_id" });
            if (upsertErr) throw upsertErr;
          }
        }

        // 3. Mark subscribers NOT in today's fetch as inactive
        const activeFanIds = fans.map((f) => f.id);
        if (activeFanIds.length > 0) {
          // Mark inactive: all rows for this creator that are currently active
          // but were NOT returned in today's API response
          const { error: deactivateErr } = await supabase
            .from("onlyfans_subscribers")
            .update({
              is_active: false,
              subscription_status: "expired",
              last_source: "reset",
              updated_at: resetAt,
            })
            .eq("creator_uuid", creator_uuid)
            .eq("is_active", true)
            .not("fan_id", "in", `(${activeFanIds.join(",")})`);

          if (deactivateErr) throw deactivateErr;
        } else {
          // No fans returned → mark all inactive
          await supabase
            .from("onlyfans_subscribers")
            .update({
              is_active: false,
              subscription_status: "expired",
              last_source: "reset",
              updated_at: resetAt,
            })
            .eq("creator_uuid", creator_uuid)
            .eq("is_active", true);
        }

        // 4. Update sync run
        await supabase
          .from("onlyfans_subscriber_sync_runs")
          .update({
            finished_at: new Date().toISOString(),
            fan_count: fans.length,
            page_count: pageCount,
            status: "success",
          })
          .eq("id", runId);

        results.push({
          creator_uuid,
          status: "success",
          fan_count: fans.length,
          page_count: pageCount,
        });
      } catch (err: any) {
        // Log error for this creator, continue to next
        await supabase
          .from("onlyfans_subscriber_sync_runs")
          .update({
            finished_at: new Date().toISOString(),
            status: "error",
            error_message: err.message?.slice(0, 500),
          })
          .eq("id", runId);

        results.push({
          creator_uuid,
          status: "error",
          error: err.message,
        });
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
