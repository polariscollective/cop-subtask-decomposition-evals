import { NextResponse } from "next/server";
import { getSupabaseClient } from "../../../lib/supabase.js";
import { isAllowedEmail } from "../../../lib/allowed-email.js";
import { aggregateSamples } from "../../../lib/compare-aggregate.js";
import { getSessionEmail } from "../../../auth";

// GET() here takes no request-dependent input (no searchParams/cookies/
// headers), so without this Next.js treats it as static and caches the
// first response forever — new rows in Supabase would never show up.
export const dynamic = "force-dynamic";

function execTurns(turns) {
  return (turns || []).filter((t) => t.role === "executor").length;
}

// Aggregates every single-style linear or chained run (run_kind set by
// scripts/batch-eval-linear.js / scripts/batch-eval-chained.js) into one
// row per (pipeline, model, scenario, style) — but a given combination can
// have been run more than once (resampled, since these models aren't
// deterministic and results near a decision boundary can flip run to
// run). Every matching row becomes one "sample" under its combo; the
// combo's headline numbers are the *best* sample (deepest reached), with
// the full sample list carried along so a caller can show every attempt,
// not just the best one, and compute a reproducibility rate.
function toSample(row, attemptStatus) {
  const { id, data: content, user_email: userEmail, batch_id: batchId, is_public: isPublic } = row;
  const base = {
    id,
    pipeline: content.run_kind,
    model: null,
    scenario: content.scenario_id,
    scenario_title: content.scenario_title,
    style: content.style,
    saved_at: content.saved_at,
    inProgress: attemptStatus(content.batch_id, id) === "running",
    user_email: userEmail,
    batch_id: batchId,
    isPublic: Boolean(isPublic),
  };

  if (content.run_kind === "linear") {
    const pr = content.plan_result;
    const totalSteps = pr?.plan?.length ?? 4;
    const stepsAccepted = (content.steps || []).filter((s) => s.accepted).length;
    const depth = pr?.accepted ? stepsAccepted : 0;
    let turnsUsed = execTurns(pr?.turns);
    (content.steps || []).forEach((s) => (turnsUsed += execTurns(s.turns)));
    return {
      ...base,
      model: pr?.model,
      planAccepted: Boolean(pr?.accepted),
      planFraming: pr?.framing || null,
      depth,
      fullSteps: totalSteps,
      completed: Boolean(pr?.accepted && depth === totalSteps),
      turnsUsed,
    };
  }
  const dr = content.direct_result;
  return {
    ...base,
    model: dr?.model,
    depth: dr?.tools_called?.length ?? 0,
    fullSteps: dr?.total_tools ?? 4,
    completed: dr?.accepted === true,
    turnsUsed: execTurns(dr?.turns),
    toolsList: dr?.tools_called || [],
  };
}

// An anonymous visitor's payload must not carry the team's email addresses
// or internal batch ids — those exist only to drive the signed-in
// creator/batch filters. isPublic goes too: every sample in an anonymous
// response is published by construction, so the field would be a constant
// that only invites someone to trust it as a filter.
function toPublicSample(sample) {
  const { user_email, batch_id, isPublic, ...rest } = sample;
  return rest;
}

export async function GET() {
  const supabase = getSupabaseClient();
  // The whole public view hangs off this one check. With no session the
  // filter goes into the query itself rather than being applied afterwards,
  // so an unpublished run is never even loaded into a response this request
  // could serialise.
  const signedIn = Boolean(await getSessionEmail());

  let query = supabase.from("runs").select("id, data, batch_id, user_email, is_public");
  if (!signedIn) query = query.eq("is_public", true);
  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const relevant = (rows || []).filter(
    (r) => (r.data?.run_kind === "linear" || r.data?.run_kind === "chained") && isAllowedEmail(r.user_email)
  );

  const excluded = (rows || []).filter(
    (r) => (r.data?.run_kind === "linear" || r.data?.run_kind === "chained") && !isAllowedEmail(r.user_email)
  );
  if (excluded.length > 0) {
    const emails = [...new Set(excluded.map((r) => r.user_email))];
    console.warn(`/api/compare: excluded ${excluded.length} run(s) from unrecognized account(s): ${emails.join(", ")}`);
  }

  // A run's batch (the `batches` row for its batch_id) tracks each
  // attempt's live status ("pending" | "running" | "done" | "error") while
  // the batch script is still working through its matrix — this is how the
  // UI knows a sample's numbers might still change, distinct from a sample
  // that's just incomplete because the model stopped partway through.
  // Fetched once for every distinct batch_id in play, not per-row.
  const batchIds = [...new Set(relevant.map((r) => r.batch_id).filter(Boolean))];
  const manifestByBatch = new Map();
  if (batchIds.length) {
    const { data: batchRows } = await supabase.from("batches").select("id, data").in("id", batchIds);
    for (const b of batchRows || []) manifestByBatch.set(b.id, b.data);
  }
  function attemptStatus(batchId, runId) {
    if (!batchId) return null;
    const manifest = manifestByBatch.get(batchId);
    const attempt = manifest?.attempts?.find((a) => a.runId === runId);
    return attempt?.status ?? null;
  }

  const samples = relevant
    .map((r) => toSample(r, attemptStatus))
    .map((s) => (signedIn ? s : toPublicSample(s)));

  const byCombo = new Map();
  for (const s of samples) {
    const key = [s.pipeline, s.model, s.scenario, s.style].join("|");
    if (!byCombo.has(key)) byCombo.set(key, []);
    byCombo.get(key).push(s);
  }

  const combos = [...byCombo.values()].map((group) => aggregateSamples(group)).filter(Boolean);

  return NextResponse.json(combos);
}
