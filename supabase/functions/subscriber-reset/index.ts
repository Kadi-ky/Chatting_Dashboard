/**
 * subscriber-reset — Supabase Edge Function (incremental / chunked)
 *
 * Called every 1 minute by pg_cron. Each invocation fetches a CHUNK
 * of fans (PAGES_PER_CHUNK × PAGE_SIZE) for each creator that still
 * has a 'running' sync for today, then saves progress and exits.
 *
 * Flow per creator per day:
 *   1. First invocation creates a sync_run row with next_offset = 0.
 *   2. Each invocation reads next_offset, fetches PAGES_PER_CHUNK pages,
 *      upserts fans, and saves the new offset.
 *   3. When the API returns hasMore = false, the final invocation
 *      deactivates stale fans and marks the run as 'success'.
 *   4. All subsequent invocations for that day are no-ops.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ONLYFANS_API_KEY = Deno.env.get("ONLYFANS_API_KEY")!;
const ONLYFANS_API_BASE = "https://app.onlyfansapi.com/api";

const PAGE_SIZE = 20;           // max allowed by OnlyFansAPI
const PAGES_PER_CHUNK = 10;     // 10 pages × 20 = 200 fans per invocation
const MAX_PAGES = 1000;         // safety cap for total pages

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Helpers ──────────────────────────────────────────────

/** Fetch a chunk of active fans starting at `offset`. */
async function fetchFanChunk(
  accountId: string,
  startOffset: number,
): Promise<{ fans: any[]; pagesFetched: number; hasMore: boolean; nextOffset: number }> {
  const fans: any[] = [];
  let offset = startOffset;
  let pagesFetched = 0;
  let hasMore = true;

  while (hasMore && pagesFetched < PAGES_PER_CHUNK) {
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
    pagesFetched++;

    hasMore = json?.data?.hasMore === true;
    offset += PAGE_SIZE;

    // Small delay between pages
    if (hasMore && pagesFetched < PAGES_PER_CHUNK) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return { fans, pagesFetched, hasMore, nextOffset: offset };
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

/** Get start of today in UTC as ISO string */
function todayStart(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// ── Main handler ─────────────────────────────────────────

serve(async (req: Request) => {
  try {
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
        JSON.stringify({ ok: true, message: "No active creators" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const results: any[] = [];
    const todayISO = todayStart();

    for (const creator of creators) {
      const { creator_uuid, onlyfans_account_id } = creator;

      // ── Check if today's sync already succeeded ──
      const { data: existingSuccess } = await supabase
        .from("onlyfans_subscriber_sync_runs")
        .select("id")
        .eq("creator_uuid", creator_uuid)
        .eq("status", "success")
        .gte("started_at", todayISO)
        .limit(1);

      if (existingSuccess && existingSuccess.length > 0) {
        results.push({ creator_uuid, status: "already_done" });
        continue;
      }

      // ── Find or create today's running sync row ──
      let { data: runRow } = await supabase
        .from("onlyfans_subscriber_sync_runs")
        .select("id, next_offset, fan_count, page_count")
        .eq("creator_uuid", creator_uuid)
        .eq("status", "running")
        .gte("started_at", todayISO)
        .order("started_at", { ascending: false })
        .limit(1)
        .single();

      if (!runRow) {
        // First invocation today — create a new running row
        const { data: newRow } = await supabase
          .from("onlyfans_subscriber_sync_runs")
          .insert({
            creator_uuid,
            started_at: new Date().toISOString(),
            status: "running",
            next_offset: 0,
            fan_count: 0,
            page_count: 0,
          })
          .select("id, next_offset, fan_count, page_count")
          .single();
        runRow = newRow;
      }

      if (!runRow) {
        results.push({ creator_uuid, status: "error", error: "Could not create sync run" });
        continue;
      }

      const runId = runRow.id;
      const currentOffset = runRow.next_offset ?? 0;
      let cumulativeFans = runRow.fan_count ?? 0;
      let cumulativePages = runRow.page_count ?? 0;

      // Safety check: don't exceed max pages
      if (cumulativePages >= MAX_PAGES) {
        results.push({ creator_uuid, status: "max_pages_reached" });
        continue;
      }

      try {
        // ── Fetch one chunk of fans ──
        const { fans, pagesFetched, hasMore, nextOffset } = await fetchFanChunk(
          onlyfans_account_id,
          currentOffset,
        );

        // ── Upsert fetched fans ──
        const resetAt = new Date().toISOString();
        if (fans.length > 0) {
          const rows = fans.map((f) =>
            normalizeFan(f, creator_uuid, onlyfans_account_id, resetAt)
          );
          for (let i = 0; i < rows.length; i += 500) {
            const chunk = rows.slice(i, i + 500);
            const { error: upsertErr } = await supabase
              .from("onlyfans_subscribers")
              .upsert(chunk, { onConflict: "creator_uuid,fan_id" });
            if (upsertErr) throw upsertErr;
          }
        }

        cumulativeFans += fans.length;
        cumulativePages += pagesFetched;

        if (hasMore) {
          // ── More pages to go — save progress and exit ──
          await supabase
            .from("onlyfans_subscriber_sync_runs")
            .update({
              next_offset: nextOffset,
              fan_count: cumulativeFans,
              page_count: cumulativePages,
            })
            .eq("id", runId);

          results.push({
            creator_uuid,
            status: "in_progress",
            fan_count: cumulativeFans,
            page_count: cumulativePages,
            next_offset: nextOffset,
          });
        } else {
          // ── All fans fetched — deactivate stale ones and mark success ──
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
            .neq("last_reset_at", resetAt);

          if (deactivateErr) throw deactivateErr;

          await supabase
            .from("onlyfans_subscriber_sync_runs")
            .update({
              finished_at: new Date().toISOString(),
              fan_count: cumulativeFans,
              page_count: cumulativePages,
              next_offset: nextOffset,
              status: "success",
            })
            .eq("id", runId);

          results.push({
            creator_uuid,
            status: "success",
            fan_count: cumulativeFans,
            page_count: cumulativePages,
          });
        }
      } catch (err: any) {
        await supabase
          .from("onlyfans_subscriber_sync_runs")
          .update({
            finished_at: new Date().toISOString(),
            status: "error",
            error_message: err.message?.slice(0, 500),
          })
          .eq("id", runId);

        results.push({ creator_uuid, status: "error", error: err.message });
      }
    }

    // If any creator still has pages left, self-invoke immediately (fire & forget).
    // This makes a single manual trigger run all the way to completion automatically.
    // The 1-min cron acts as a safety net if this fails.
    const anyInProgress = results.some((r) => r.status === "in_progress");
    if (anyInProgress) {
      fetch(`${SUPABASE_URL}/functions/v1/subscriber-reset`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
      }).catch(() => {});
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
