import { NextResponse } from "next/server";
import { ARGUMENT_STYLES } from "../../../lib/adversarial";
import { getSupabaseClient } from "../../../lib/supabase.js";
import { getSessionEmail } from "../../../auth";
import { publicScenarioIds, runIsPublic } from "../../../lib/publication.js";

// Same fixed priority order the batch runner uses to pick which accepted
// style becomes the canonical branch that continues to the next step
// (baseline first, then this order) — see scripts/batch/steps-run.js's
// pickCanonical. Needed here to reconstruct, from saved rows alone, which
// row at a given step was the one anything downstream branched from.
const STYLE_PRIORITY = Object.keys(ARGUMENT_STYLES);

// Resolved only for anonymous callers, and only for the single row being
// served. Both tables are small (5 and 25 rows), and neither filters deleted_at
// on the scenario side: every run in the bank ran against a retired _v0 row, so
// reading retirement as unpublication would 404 every transcript on the public
// grid. Fails closed on a query error.
async function runIsPubliclyReadable(supabase, row) {
  const [{ data: scenarios, error }, { data: families, error: familyError }] = await Promise.all([
    supabase.from("scenarios").select("scenario_id, family_id, is_public"),
    supabase.from("scenario_families").select("id, is_public, deleted_at"),
  ]);
  if (error || familyError) return false;
  return runIsPublic(row, publicScenarioIds(scenarios || [], families || []));
}

// GET /api/runs         -> list of saved runs (lightweight summaries)
// GET /api/runs?id=<id> -> full content of one saved run
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const supabase = getSupabaseClient();

  if (id) {
    // Reading a run stays team-wide: the public root's transcript modal is
    // the only way to read a run's conversation, and the runs explorer is
    // deliberately shared. What must NOT be shared is loading a run into the
    // editor to continue and overwrite it — so the payload reports whether
    // the caller owns it, and the client refuses to adopt an identity it
    // doesn't own. The real write-side guard is POST /api/save-run's own
    // ownership check.
    const userEmail = await getSessionEmail();
    const { data: row, error } = await supabase
      .from("runs")
      .select("data, style, user_email, is_public, scenario_id, ran_against_scenario_id")
      .eq("id", id)
      // A soft-deleted run is gone from the app, not just from the lists —
      // otherwise an id captured before the delete still opens its transcript.
      .is("deleted_at", null)
      .maybeSingle();
    if (error || !row) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // Anonymous readers exist only because / is public. They may read a
    // transcript, but only of a run published under the whole conjunction: its
    // own flag, both of its scenarios, and their family. The run's flag alone is
    // not enough here of all places — the transcript carries the tool schemas
    // and descriptions of the version it executed against, verbatim, so serving
    // it publishes that scenario's text whatever the scenario row says.
    //
    // An unpublished id gets the same 404 as a missing one, so the response
    // never confirms that an id it was handed actually exists.
    if (!userEmail && !(await runIsPubliclyReadable(supabase, row))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // The root style column rides along with the run content: it's the only
    // record that MORE THAN ONE style was used ("hybrid"), which the nested
    // per-call argument_style fields can never express on their own. Without
    // it, loading a hybrid run and re-saving silently downgrades it to
    // whichever single style happened to be used last.
    // The column is the source of truth going forward, but batch rows predate
    // it and carry their style only in the blob — fall back rather than
    // shadowing a real value with null.
    return NextResponse.json({
      ...row.data,
      style: row.style ?? row.data?.style ?? null,
      // Both ids, because they can differ: scenario_id is the live scenario
      // this run counts toward after a revision carried it over,
      // ran_against_scenario_id is the version it actually executed against.
      // A viewer shown the current spec next to an older transcript needs to
      // be told, or the tool schemas in the transcript won't match the page.
      scenario_id: row.scenario_id ?? row.data?.scenario_id ?? null,
      ran_against_scenario_id: row.ran_against_scenario_id ?? row.data?.scenario_id ?? null,
      // Guarded on userEmail as well as the comparison: an anonymous caller
      // reading a batch row whose user_email is null would otherwise come out
      // as the owner (null === null).
      owned: Boolean(userEmail) && row.user_email === userEmail,
    });
  }

  // The /dashboard page's "Browse saved runs" widget passes mine=true: it's
  // the surface you load a run from to continue and overwrite it, so it must
  // only ever offer runs the caller actually owns. /runs and / pass nothing
  // and keep their existing team-wide visibility.
  let query = supabase
    .from("runs")
    .select("id, style, data, user_email, scenario_id, ran_against_scenario_id")
    .is("deleted_at", null);
  // Resolved for every request, not just the scoped one: the team-wide list
  // still has to say which rows are the caller's, so /runs can offer "Open"
  // only where loading is actually allowed.
  const userEmail = await getSessionEmail();
  if (!userEmail) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  if (searchParams.get("mine") === "true") {
    query = query.eq("user_email", userEmail);
  }
  const { data: rows, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const summaries = rows.map((row) => {
    const id = row.id;
    const content = row.data;
    try {
      const hasSteps = Array.isArray(content.steps) && content.steps.length > 0;
      const mode = hasSteps ? "execution" : content.plan_result ? "plan" : "direct";

      // A saved run with steps reflects two separate questions: did THIS
      // step get accepted, and did execution actually reach the END of
      // the plan? Those aren't the same thing — a row can be "step 2/4,
      // accepted" and still not mean the dilemma's full action sequence
      // ran, since steps 3-4 haven't been attempted (in this row; other
      // rows continue from here). So `accepted` here means "reached the
      // last step, and it succeeded" — full completion — while
      // `step_outcome` distinguishes that from "refused at this step" and
      // "accepted here but not the final step yet" (in_progress), so an
      // intermediate success is never mislabeled as a refusal.
      let accepted;
      let stepAccepted = null;
      let stepOutcome = null;
      let stepProgress = null;
      let stepIndex = null;
      let stepTotal = null;
      let resultSource;
      if (hasSteps) {
        const lastStep = content.steps[content.steps.length - 1];
        stepIndex = content.steps.length;
        stepTotal = content.plan_result?.plan?.length ?? null;
        const isFinalStep = stepTotal != null && stepIndex === stepTotal;
        stepAccepted = lastStep.accepted;
        accepted = isFinalStep && lastStep.accepted;
        stepOutcome = !lastStep.accepted ? "stopped" : isFinalStep ? "completed" : "in_progress";
        stepProgress = stepTotal
          ? `${stepIndex}/${stepTotal}${lastStep.accepted ? "" : " (refused here)"}`
          : `${stepIndex}`;
        resultSource = lastStep;
      } else {
        accepted = mode === "plan" ? content.plan_result?.accepted : content.direct_result?.accepted;
        resultSource = content.plan_result || content.direct_result || {};
      }

      const cost = hasSteps
        ? content.steps.reduce((sum, s) => sum + (s.total_cost || 0), 0)
        : resultSource.total_cost || 0;

      return {
        id,
        saved_at: content.saved_at,
        // The live scenario, so the list groups and filters with the grid
        // rather than stranding a carried-over cohort under its old id.
        scenario_id: row.scenario_id ?? content.scenario_id,
        ran_against_scenario_id: row.ran_against_scenario_id ?? content.scenario_id,
        scenario_title: content.scenario_title,
        framing: content.framing,
        // Root-level style recorded at save time: a single style key, "all"
        // (rotate every round), or "hybrid" (the style changed mid-run).
        // Null for rows saved before this column existed — their per-call
        // argument_style values still live in `data` and are shown by the
        // detail views that read it directly.
        style: row.style ?? content.style ?? null,
        owned: row.user_email === userEmail,
        mode,
        accepted,
        step_accepted: stepAccepted,
        step_outcome: stepOutcome,
        step_count: content.steps?.length ?? 0,
        step_progress: stepProgress,
        step_index: stepIndex,
        step_total: stepTotal,
        model: resultSource.model || null,
        argument_style: resultSource.argument_style || null,
        cost,
        batch_id: content.batch_id || null,
        // Groups every row that belongs to the same overall run together:
        // an execution attempt's chain_id is the plan row it's executing
        // (content.source_plan_id); a plan row's chain_id is its own id,
        // since it's the root of its own chain. Two rows can share
        // scenario/model/framing/style and still be completely unrelated
        // branch points — chain_id (+ step_index) is what actually says
        // "these belong to the same run."
        chain_id: content.source_plan_id || id,
        description: content.description || null,
      };
    } catch (e) {
      return { id, error: "unreadable" };
    }
  });

  // A row is a "leaf" if nothing in its chain continues from it — the
  // frontier of exploration, not a step that's since been superseded.
  // Every row defaults to leaf; we clear it on exactly the rows that
  // something downstream branched from: the plan (step 0) if any
  // execution was attempted at all, and — per step — whichever attempt
  // was the "canonical" one (baseline if accepted, else the first
  // accepted style in STYLE_PRIORITY order, mirroring pickCanonical in
  // scripts/batch/steps-run.js) if a next step exists for that chain.
  const usable = summaries.filter((r) => !r.error);
  for (const r of usable) r.is_leaf = true;
  const byChain = new Map();
  for (const r of usable) {
    if (!byChain.has(r.chain_id)) byChain.set(r.chain_id, []);
    byChain.get(r.chain_id).push(r);
  }
  for (const chainRows of byChain.values()) {
    const planRow = chainRows.find((r) => r.mode !== "execution");
    const stepRows = chainRows.filter((r) => r.mode === "execution");
    if (planRow) planRow.is_leaf = stepRows.length === 0;

    const maxStep = stepRows.reduce((m, r) => Math.max(m, r.step_index || 0), 0);
    for (let step = 1; step <= maxStep; step++) {
      const hasNext = stepRows.some((r) => r.step_index === step + 1);
      if (!hasNext) continue;
      const atStep = stepRows.filter((r) => r.step_index === step);
      const baseline = atStep.find((r) => r.argument_style === "baseline");
      let canonical = baseline?.step_accepted ? baseline : null;
      if (!canonical) {
        const acceptedStyles = atStep
          .filter((r) => r.step_accepted && r.argument_style !== "baseline")
          .sort((a, b) => STYLE_PRIORITY.indexOf(a.argument_style) - STYLE_PRIORITY.indexOf(b.argument_style));
        canonical = acceptedStyles[0] || null;
      }
      if (canonical) canonical.is_leaf = false;
    }
  }

  summaries.sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || ""));
  return NextResponse.json(summaries);
}
