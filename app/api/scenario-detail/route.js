import { NextResponse } from "next/server";
import { normalizeScenarioDoc, validateScenarioDoc } from "../../../lib/scenarios";
import { getSessionEmail } from "../../../auth";
import { getSupabaseClient } from "../../../lib/supabase.js";
import { isAllowedEmail } from "../../../lib/allowed-email.js";

// Publication is a property of the family: a public family publishes its whole
// dressing set, run activity or not — the same rule /api/families lists them
// by (see buildFamilyView). Without this, a scenario that page now shows would
// 404 the moment a reader clicked it. Fails closed: a query error, a missing
// scenario, a scenario in no family, or a soft-deleted family all return false.
async function belongsToPublicFamily(supabase, scenarioId) {
  const { data: scenario, error } = await supabase
    .from("scenarios")
    .select("family_id")
    .eq("scenario_id", scenarioId)
    .maybeSingle();
  if (error || !scenario?.family_id) return false;

  const { data: family, error: familyError } = await supabase
    .from("scenario_families")
    .select("is_public")
    .eq("id", scenario.family_id)
    .is("deleted_at", null)
    .maybeSingle();
  return !familyError && family?.is_public === true;
}

// The pre-existing unlock, unchanged: a scenario the public grid shows results
// for stays readable even if its family is unpublished or it has none.
// Mirrors /api/compare's inclusion rule on every axis it checks — not just
// "published": a published run from a non-allowlisted account (e.g. a QA
// account like reviewer-verify@example.com), or one whose blob has no
// recognized run_kind (e.g. a manually-saved run — see
// app/api/save-run/route.js, which never sets run_kind; only the batch scripts
// do), never appears in that grid, so it must not unlock a spec here either.
async function hasPublicRun(supabase, scenarioId) {
  const { data: candidates, error } = await supabase
    .from("runs")
    .select("data, user_email")
    // Either column unlocks the spec. After a revision carries runs over,
    // scenario_id names the live row, so the superseded one would 404 — and
    // that is exactly the page a version banner links to from a transcript
    // recorded against it. A run published under one is published under both;
    // they are two names for the same run.
    .or(`scenario_id.eq.${scenarioId},ran_against_scenario_id.eq.${scenarioId}`)
    .eq("is_public", true)
    // A soft-deleted run no longer appears in the public grid, so it must not
    // unlock this scenario's spec either.
    .is("deleted_at", null);
  if (error) return false;
  return (candidates || []).some(
    (r) =>
      isAllowedEmail(r.user_email) &&
      (r.data?.run_kind === "linear" || r.data?.run_kind === "chained")
  );
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }

  const supabase = getSupabaseClient();

  // Anonymous readers reach this from two public surfaces: the root /'s grid,
  // where a result's scenario title opens its spec, and /families, which lists
  // every scenario of every published family. Either origin unlocks the spec,
  // and nothing else does — otherwise a scenario belonging to no published
  // family, with nothing published against it, would be readable by guessing
  // its id. Same 404 whichever way it fails, so the response never
  // distinguishes "unpublished" from "does not exist".
  const userEmail = await getSessionEmail();
  if (!userEmail) {
    const allowed =
      (await belongsToPublicFamily(supabase, scenarioId)) ||
      (await hasPublicRun(supabase, scenarioId));
    if (!allowed) {
      return NextResponse.json({ error: `Scenario not found: ${scenarioId}` }, { status: 404 });
    }
  }

  // Deliberately not filtered on deleted_at: a superseded scenario has to
  // stay readable, since it is the definition an older run actually saw.
  const { data: row, error } = await supabase
    .from("scenarios")
    .select("data, created_by, deleted_at, supersedes, revised_at, revision_note, updated_at")
    .eq("scenario_id", scenarioId)
    .single();
  if (error || !row) {
    return NextResponse.json({ error: `Scenario not found: ${scenarioId}` }, { status: 404 });
  }

  // Every grading this scenario has had, newest first. Not just the latest:
  // two judges disagreeing is the point of keeping them all (see the table
  // comment), and a reader deciding whether to trust a score should be able to
  // see that it was scored once by one model rather than agreed on.
  //
  // Visibility follows the spec's: these are derived from the scenario text,
  // not from anyone's runs, so a reader allowed to see the chain is allowed to
  // see how it was graded. created_by is dropped for anonymous readers, same
  // rule as the scenario's own.
  const { data: metricRows } = await supabase
    .from("scenario_metrics")
    .select("judge_model, judge_provider, dimensions, legibility, cost, created_at, created_by, graded_scenario_updated_at")
    .eq("scenario_id", scenarioId)
    .order("created_at", { ascending: false });

  const metrics = (metricRows || []).map((m) => ({
    judge_model: m.judge_model,
    judge_provider: m.judge_provider,
    dimensions: m.dimensions || {},
    legibility: m.legibility || null,
    created_at: m.created_at,
    // Whether this grading scored the wording currently on the page. A pass
    // taken before an edit describes text that no longer exists, so it must
    // not be folded into the median — and null means "unknown", which is
    // treated the same way.
    stale: !m.graded_scenario_updated_at || m.graded_scenario_updated_at !== row.updated_at,
    ...(userEmail ? { cost: m.cost, created_by: m.created_by } : {}),
  }));

  // Which row, if any, replaced this one — so a viewer who followed a banner
  // back to a superseded version can find their way forward again.
  const { data: successor } = await supabase
    .from("scenarios")
    .select("scenario_id")
    .eq("supersedes", scenarioId)
    .maybeSingle();

  return NextResponse.json({
    ...row.data,
    metrics,
    // The lineage itself is public: a reader comparing a transcript with this
    // page has to be able to reach the version that transcript was recorded
    // against, or the mismatch between them reads as a bug.
    supersedes: row.supersedes ?? null,
    superseded_by: successor?.scenario_id ?? null,
    revised_at: row.revised_at ?? null,
    // revision_note is not. It is the internal record of what changed and
    // whether the old runs were carried over despite it — a working note about
    // the instrument's own weaknesses, written for whoever maintains the bank,
    // not a caveat to publish under every result. Same treatment as
    // created_by: it goes only to a caller that already has a session.
    ...(userEmail ? { revision_note: row.revision_note ?? null } : {}),
    // created_by is an account email, and this endpoint is anonymously
    // readable for published scenarios — so it goes only to a caller that
    // already has a session. The signed-in surfaces that use it
    // (EditScenarioForm, ScenariosList) are unaffected.
    ...(userEmail ? { created_by: row.created_by } : {}),
    deleted: row.deleted_at != null,
  });
}

async function requireOwnedScenario(scenarioId) {
  const userEmail = await getSessionEmail();
  if (!userEmail) return { error: NextResponse.json({ error: "not signed in" }, { status: 401 }) };

  const supabase = getSupabaseClient();
  const { data: existing, error } = await supabase
    .from("scenarios")
    .select("created_by, deleted_at")
    .eq("scenario_id", scenarioId)
    .single();
  if (error || !existing) {
    return { error: NextResponse.json({ error: `Scenario not found: ${scenarioId}` }, { status: 404 }) };
  }
  if (existing.created_by !== userEmail) {
    return { error: NextResponse.json({ error: "only the creator can modify this scenario" }, { status: 403 }) };
  }
  // A deleted scenario is still readable (old runs reference it) but is no
  // longer a live thing to change — editing or re-deleting one is always a
  // mistake, and there is no undelete for it to be half of.
  if (existing.deleted_at) {
    return { error: NextResponse.json({ error: "this scenario is deleted" }, { status: 409 }) };
  }
  return { supabase };
}

export async function PUT(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }

  const { supabase, error: authError } = await requireOwnedScenario(scenarioId);
  if (authError) return authError;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, errors: [{ field: "root", message: "body must be JSON" }] }, { status: 400 });
  }
  const submitted = { ...body, scenario_id: scenarioId }; // scenario_id is immutable
  const { ok, errors } = validateScenarioDoc(submitted);
  if (!ok) {
    return NextResponse.json({ ok: false, errors }, { status: 400 });
  }
  const doc = normalizeScenarioDoc(submitted);

  const { error: updateError } = await supabase
    .from("scenarios")
    .update({
      title: doc.title,
      dilemma_id: doc.dilemma_id,
      updated_at: new Date().toISOString(),
      data: doc,
    })
    .eq("scenario_id", scenarioId);
  if (updateError) {
    return NextResponse.json({ ok: false, errors: [{ field: "root", message: updateError.message }] }, { status: 500 });
  }

  return NextResponse.json({ ok: true, scenario_id: scenarioId });
}

export async function DELETE(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }

  const { supabase, error: authError } = await requireOwnedScenario(scenarioId);
  if (authError) return authError;

  const { error: updateError } = await supabase
    .from("scenarios")
    .update({ deleted_at: new Date().toISOString() })
    .eq("scenario_id", scenarioId);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
