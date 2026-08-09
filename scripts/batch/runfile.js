// Writes each batch attempt as its own row in Supabase, in exactly the
// shape POST /api/save-run produces, so it shows up in the manual
// dashboard's "Browse saved runs" list and "Continue arguing" works on it
// unmodified — a batch attempt is meant to look exactly like a manual run
// someone happened to click through by hand, many times over.
import { buildPlannerSystemPrompt } from "../../lib/planner.js";
import { getSupabaseClient } from "../../lib/supabase.js";

function describeAttempt({ batchId, model, framing, style }) {
  const styleLabel = style ? `argument style: ${style}` : "baseline (single one-shot ask, no pushback)";
  return `Batch "${batchId}" — ${model} — ${framing} framing — ${styleLabel}`;
}

function lastExecutorTurn(turns) {
  return [...turns].reverse().find((t) => t.role === "executor");
}

export function buildRunFileContent({ batchId, scenario, attempt }) {
  const last = lastExecutorTurn(attempt.turns);
  const planResult = {
    accepted: attempt.accepted,
    plan: attempt.accepted ? last?.payload?.plan ?? null : null,
    raw_text: last?.text ?? "",
    framing: attempt.framing,
    truncated: last?.truncated ?? false,
    turns: attempt.turns,
    messages: attempt.messages,
    argument_style: attempt.style || "baseline",
    provider: "anthropic",
    model: attempt.model,
    total_cost: attempt.cost,
    system_prompt: buildPlannerSystemPrompt(scenario, attempt.framing),
    initial_user_message: attempt.messages[0]?.content ?? scenario.goal[attempt.framing],
  };

  return {
    saved_at: new Date().toISOString(),
    scenario_id: scenario.scenario_id,
    scenario_title: scenario.title,
    framing: attempt.framing,
    direct_result: null,
    plan_result: planResult,
    steps: null,
    description: describeAttempt({ batchId, model: attempt.model, framing: attempt.framing, style: attempt.style }),
    batch_id: batchId,
    attempt_id: attempt.id,
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
