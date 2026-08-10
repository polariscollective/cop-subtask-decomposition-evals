import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSessionEmail } from "../../../auth";
import { getSupabaseClient } from "../../../lib/supabase.js";

export async function POST(req) {
  const userEmail = await getSessionEmail();
  if (!userEmail) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const { scenarioId, scenarioTitle, framing, directResult, planResult, steps, description, runId, style } =
    await req.json();
  if (!scenarioId || (!planResult && !directResult)) {
    return NextResponse.json(
      { error: "missing scenarioId, or neither planResult nor directResult was provided" },
      { status: 400 }
    );
  }

  const id = randomUUID();
  const run = {
    saved_at: new Date().toISOString(),
    scenario_id: scenarioId,
    scenario_title: scenarioTitle || null,
    framing,
    // Recorded in the blob as well as the column: /api/compare reads the
    // blob's style, the column is what the runs list reads.
    style: style || null,
    direct_result: directResult || null,
    plan_result: planResult || null,
    steps: steps || null,
    // Optional free-text note, shown in the "Browse saved runs" list so a
    // specific run can be found later without opening every one. The
    // scenario itself isn't repeated here since scenario_title already
    // covers that.
    description: description || null,
  };

  const supabase = getSupabaseClient();

  // Continuing a run and re-saving overwrites the row being iterated on
  // rather than branching into a duplicate — a run is one linear thread,
  // one row. The user_email guard is defense-in-depth: the only surface
  // that hands out a runId to save against is GET /api/runs?mine=true,
  // which already returns nothing but the caller's own runs.
  if (runId) {
    // Read the row first: an overwrite must not erase provenance the manual
    // flow doesn't model. Batch rows carry run_kind / batch_id /
    // plan_result_real_attempt, and /api/compare decides inclusion from
    // data.run_kind — rebuilding the blob from scratch would turn a batch row
    // into an orphan that still has a batch_id column but has silently
    // vanished from the comparison view.
    const { data: existing, error: readError } = await supabase
      .from("runs")
      .select("data")
      .eq("id", runId)
      .eq("user_email", userEmail)
      .maybeSingle();
    if (readError) {
      return NextResponse.json({ error: readError.message }, { status: 500 });
    }
    if (!existing) {
      // Not ours, or gone. Reporting success here would tell the user their
      // work was saved when nothing was written.
      return NextResponse.json({ error: "run not found, or not yours to overwrite" }, { status: 404 });
    }

    // /api/compare reads the style from the BLOB, not the column, so a run
    // that has become "hybrid" through manual continuation has to say so in
    // both places or it keeps aggregating under its original style.
    const mergedData = { ...existing.data, ...run, style: style || null };

    const { error: updateError } = await supabase
      .from("runs")
      .update({
        scenario_id: scenarioId,
        scenario_title: scenarioTitle || null,
        framing,
        style: style || null,
        description: description || null,
        data: mergedData,
      })
      .eq("id", runId)
      .eq("user_email", userEmail);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    return NextResponse.json({ saved: true, id: runId });
  }

  const { error } = await supabase.from("runs").insert({
    id,
    user_email: userEmail,
    scenario_id: scenarioId,
    scenario_title: scenarioTitle || null,
    framing,
    style: style || null,
    source_plan_id: null,
    batch_id: null,
    description: description || null,
    data: run,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ saved: true, id });
}
