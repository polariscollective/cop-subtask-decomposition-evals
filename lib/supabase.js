import { createClient } from "@supabase/supabase-js";

let client = null;

export function getSupabaseClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.");
  }
  // supabase-js calls global fetch, which Next.js replaces in the App Router
  // with a caching wrapper — so a GET issued through this client can be served
  // from Next's Data Cache and return rows that no longer match the database.
  // Observed directly: after an UPDATE set family_id on two scenarios,
  // /api/families kept reporting them unassigned until the server restarted.
  //
  // A route's `export const dynamic = "force-dynamic"` does NOT cover this.
  // That opts the *route* out of being statically rendered; this is the
  // separate, lower fetch-level cache, and every route reading through this
  // client was exposed to it, not just the newest one.
  //
  // No read in this app ever wants a cached answer — the dashboard, the
  // compare grid and the batch status endpoints are all meant to reflect
  // Supabase as it is right now — so the opt-out belongs here, once, rather
  // than at each call site where it can be forgotten.
  client = createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
  return client;
}
