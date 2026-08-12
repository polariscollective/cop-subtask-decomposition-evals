import { NextResponse } from "next/server";
import { getSupabaseClient } from "../../../lib/supabase.js";
import { isAllowedEmail } from "../../../lib/allowed-email.js";
import { buildFamilyView } from "../../../lib/families.js";
import { publicScenarioIds, runIsPublic } from "../../../lib/publication.js";
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
    // Retired rows are fetched too, and dropped by buildFamilyView's own
    // deleted_at guard rather than by the query. They are needed for the run
    // counts below: every run in the bank ran against a retired _v0 row, and
    // the conjunction requires that row to be published — a set built from live
    // scenarios alone would report "0 runs" on every scenario on the page.
    supabase.from("scenarios").select("scenario_id, title, family_id, data, is_public, deleted_at"),
  ]);
  if (familyError) return NextResponse.json({ error: familyError.message }, { status: 500 });
  if (scenarioError) return NextResponse.json({ error: scenarioError.message }, { status: 500 });

  // Which runs count. Scenario visibility is NOT derived from this — a scenario
  // is listed on its own two flags (see buildFamilyView), published or not
  // against. This is only the number shown next to it, and it uses the same
  // inclusion rule as /api/compare: published under the full conjunction, not
  // soft-deleted, from a recognised account, and of a recognised run_kind — so
  // the count always matches the dataset the visitor could actually open, and
  // reads "0 runs" when there is none.
  let runQuery = supabase
    .from("runs")
    .select("scenario_id, ran_against_scenario_id, is_public, data, user_email")
    .is("deleted_at", null);
  if (!signedIn) runQuery = runQuery.eq("is_public", true);
  const { data: runs, error: runError } = await runQuery;
  if (runError) return NextResponse.json({ error: runError.message }, { status: 500 });

  // Built from the rows already fetched above. For an anonymous caller those
  // families are the published ones only, so a scenario whose family is absent
  // resolves to unpublished without a second query.
  const publicIds = signedIn ? null : publicScenarioIds(scenarios || [], families || []);

  const runCountsByScenario = {};
  for (const r of runs || []) {
    const kind = r.data?.run_kind;
    if (kind !== "linear" && kind !== "chained") continue;
    if (!isAllowedEmail(r.user_email)) continue;
    // A run counts against the version it is attributed to, but it is only
    // openable when the version it actually EXECUTED against is published too
    // — so the conjunction decides the count, not just scenario_id.
    if (publicIds && !runIsPublic(r, publicIds)) continue;
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
