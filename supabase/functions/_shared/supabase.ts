// Service-role Supabase client singleton.
// Imported by every chat Edge Function so we don't recreate the client per-request.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Resolve creator_uuid + onlyfans_account_id from a webhook's account_id. */
export async function resolveCreator(
  accountId: string,
): Promise<{ creator_uuid: string; onlyfans_account_id: string } | null> {
  const { data, error } = await supabase
    .from("creator_onlyfans_accounts")
    .select("creator_uuid, onlyfans_account_id")
    .eq("onlyfans_account_id", accountId)
    .eq("is_active", true)
    .single();
  return error || !data ? null : data;
}
