import { NextResponse } from "next/server";
import { getSupabaseClient } from "../../../lib/supabase.js";
import { isAllowedEmail } from "../../../lib/allowed-email.js";
import { buildFamilyView } from "../../../lib/families.js";
import { getSessionEmail } from "../../../auth";

// Same reason as /api/compare: this GET takes no request-dependent input, so
// without this Next.js would treat it as static and serve the first response
// forever — a family flipped to is_public in Supabase would never appear.
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = getSupabaseClient();
  const signedIn = Boolean(await getSessionEmail());

  // The publication filter goes into the query, not into a post-filter, so an
  // unpublished family is never loaded into a response this request could
  // serialise. Identical discipline to /api/compare.
  let familyQuery = supabase
    .from("scenario_families")
    .select("id, label, tradeoff, answer_status, answer_basis, description, harness_fit, harness_note, source, is_public, deleted_at")
    .is("deleted_at", null);
  if (!signedIn) familyQuery = familyQuery.eq("is_public", true);

  const [{ data: families, error: familyError }, { data: scenarios, error: scenarioError }] = await Promise.all([
    familyQuery,
    supabase.from("scenarios").select("scenario_id, title, family_id, data, deleted_at").is("deleted_at", null),
  ]);
  if (familyError) return NextResponse.json({ error: familyError.message }, { status: 500 });
  if (scenarioError) return NextResponse.json({ error: scenarioError.message }, { status: 500 });

  // Which runs count. Scenario visibility is NOT derived from this — it
  // follows the family's publication (see buildFamilyView). This is only the
  // number shown next to a scenario, and it uses the same inclusion rule as
  // /api/compare: published, not soft-deleted, from a recognised account, and
  // of a recognised run_kind — so the count always matches the dataset the
  // visitor could actually open, and reads "0 runs" when there is none.
  let runQuery = supabase.from("runs").select("scenario_id, data, user_email").is("deleted_at", null);
  if (!signedIn) runQuery = runQuery.eq("is_public", true);
  const { data: runs, error: runError } = await runQuery;
  if (runError) return NextResponse.json({ error: runError.message }, { status: 500 });

  const runCountsByScenario = {};
  for (const r of runs || []) {
    const kind = r.data?.run_kind;
    if (kind !== "linear" && kind !== "chained") continue;
    if (!isAllowedEmail(r.user_email)) continue;
    runCountsByScenario[r.scenario_id] = (runCountsByScenario[r.scenario_id] || 0) + 1;
  }

  return NextResponse.json(
    buildFamilyView({
      families: families || [],
      scenarios: scenarios || [],
      runCountsByScenario,
      signedIn,
    })
  );
}
