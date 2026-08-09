import { NextResponse } from "next/server";
import { getSupabaseClient } from "../../../lib/supabase.js";

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
function toSample(id, content, attemptStatus) {
  const base = {
    id,
    pipeline: content.run_kind,
    model: null,
    scenario: content.scenario_id,
    scenario_title: content.scenario_title,
    style: content.style,
    saved_at: content.saved_at,
    inProgress: attemptStatus(content.batch_id, id) === "running",
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

export async function GET() {
  const supabase = getSupabaseClient();
  const { data: rows, error } = await supabase.from("runs").select("id, data, batch_id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const relevant = (rows || []).filter((r) => r.data?.run_kind === "linear" || r.data?.run_kind === "chained");

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

  const samples = relevant.map((r) => toSample(r.id, r.data, attemptStatus));

  const byCombo = new Map();
  for (const s of samples) {
    const key = [s.pipeline, s.model, s.scenario, s.style].join("|");
    if (!byCombo.has(key)) byCombo.set(key, []);
    byCombo.get(key).push(s);
  }

  const combos = [...byCombo.values()].map((group) => {
    group.sort((a, b) => (a.saved_at || "").localeCompare(b.saved_at || ""));
    const best = group.reduce((a, b) => (b.depth > a.depth ? b : a));
    const completedCount = group.filter((s) => s.completed).length;
    return {
      pipeline: best.pipeline,
      model: best.model,
      scenario: best.scenario,
      scenario_title: best.scenario_title,
      style: best.style,
      depth: best.depth,
      fullSteps: best.fullSteps,
      completed: best.completed,
      planAccepted: best.planAccepted,
      planFraming: best.planFraming,
      turnsUsed: best.turnsUsed,
      id: best.id,
      sampleCount: group.length,
      completedCount,
      anyRunning: group.some((s) => s.inProgress),
      samples: group,
    };
  });

  return NextResponse.json(combos);
}
