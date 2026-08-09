// One row per (model, scenario, style) chain — the whole run (plan, then
// steps 1..N until the first refusal) lives in a single GUI-compatible
// row, matching exactly how a human clicking through the manual dashboard
// would produce it: plan_result once, steps appended in order.
import { getSupabaseClient } from "../../lib/supabase.js";

export function buildLinearRunFileContent({ batchId, scenario, chain }) {
  const stepsDone = chain.steps.length;
  const totalSteps = chain.planResult?.plan?.length ?? null;
  const framing = chain.planResult?.framing || "real";
  const description = !chain.planResult?.accepted
    ? `Linear batch "${batchId}" — ${chain.model} — ${framing} framing — style: ${chain.style} — plan refused`
    : `Linear batch "${batchId}" — ${chain.model} — accepted under ${framing} framing — style: ${chain.style} — reached step ${stepsDone}${totalSteps ? "/" + totalSteps : ""}`;

  return {
    saved_at: new Date().toISOString(),
    scenario_id: scenario.scenario_id,
    scenario_title: scenario.title,
    framing,
    direct_result: null,
    // Only set when the real-framing plan attempt was fully exhausted and
    // refused, causing a fresh test-framing retry — preserves that first
    // (discarded) transcript for the modal, distinct from plan_result
    // (the decisive attempt everything else — depth, turnsUsed, — reads).
    plan_result_real_attempt: chain.planResultReal,
    plan_result: chain.planResult,
    steps: chain.steps,
    description,
    batch_id: batchId,
    run_kind: "linear",
    style: chain.style,
  };
}

export async function writeRunFile(runId, content) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("runs").upsert({
    id: runId,
    user_email: process.env.RUN_AUTHOR_EMAIL,
    scenario_id: content.scenario_id,
    scenario_title: content.scenario_title,
    framing: content.framing,
    source_plan_id: content.source_plan_id || null,
    batch_id: content.batch_id || null,
    description: content.description || null,
    data: content,
  });
  if (error) throw new Error(`Failed to write run ${runId}: ${error.message}`);
}
