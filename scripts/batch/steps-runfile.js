// Writes each step-execution attempt as its own row in Supabase, in
// exactly the shape POST /api/save-run produces for a plan+steps
// walkthrough — the original accepted plan (plan_result, unchanged) plus a
// `steps` array containing the canonical result for every step reached
// before this one, ending in this specific attempt's own result. That
// makes each row loadable in the manual dashboard exactly where a human
// would be if they'd clicked through to this point by hand, ready to
// "Continue arguing" or "Retry" on the last step.
import { buildExecutorSystemPrompt, buildExecutorUserMessage } from "../../lib/executor.js";
import { getSupabaseClient } from "../../lib/supabase.js";

function describeStepAttempt({ batchId, sourceId, stepIndex, model, style }) {
  const styleLabel = style ? `argument style: ${style}` : "baseline (single one-shot ask, no pushback)";
  return `Step batch "${batchId}" — step ${stepIndex} of plan from "${sourceId}" — ${model} — ${styleLabel}`;
}

function lastExecutorTurn(turns) {
  return [...turns].reverse().find((t) => t.role === "executor");
}

// `priorCanonicalSteps`: array of already-finalized step entries (indices
// 1..stepIndex-1), in the exact shape stored in a saved run's `steps`
// array. `resolvedArgs`/`toolName`/`priorStepOutputText` describe this
// attempt's own step.
export function buildStepRunFileContent({
  batchId,
  sourcePlan,
  scenario,
  attempt,
  priorCanonicalSteps,
  resolvedArgs,
  toolName,
  priorStepOutputText,
}) {
  const last = lastExecutorTurn(attempt.turns);
  const ownStep = {
    accepted: attempt.accepted,
    tool_call_args: attempt.accepted ? last?.payload?.arguments ?? null : null,
    output: attempt.accepted ? attempt.output ?? null : null,
    raw_text: last?.text ?? "",
    truncated: last?.truncated ?? false,
    turns: attempt.turns,
    messages: attempt.messages,
    argument_style: attempt.style || "baseline",
    provider: "anthropic",
    model: attempt.model,
    total_cost: attempt.cost,
    system_prompt: buildExecutorSystemPrompt(),
    initial_user_message:
      attempt.messages[0]?.content ??
      buildExecutorUserMessage({ toolName, args: resolvedArgs, priorStepOutputText }),
    tool: toolName,
    args: resolvedArgs,
  };

  return {
    saved_at: new Date().toISOString(),
    scenario_id: scenario.scenario_id,
    scenario_title: scenario.title,
    framing: sourcePlan.planResult.framing,
    direct_result: null,
    plan_result: sourcePlan.planResult,
    steps: [...priorCanonicalSteps, ownStep],
    description: describeStepAttempt({
      batchId,
      sourceId: sourcePlan.sourceId,
      stepIndex: attempt.step_index,
      model: attempt.model,
      style: attempt.style,
    }),
    batch_id: batchId,
    attempt_id: attempt.id,
    source_plan_id: sourcePlan.sourceId,
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

export async function readRunFile(runId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("runs").select("data").eq("id", runId).single();
  if (error) throw new Error(`Failed to read run ${runId}: ${error.message}`);
  return data.data;
}
