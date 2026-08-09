// One row per (model, scenario, style) chained run — saved as a
// direct_result (like POST /api/ask-direct produces), since the manual
// dashboard's TurnBody already renders each turn's own tool call as it
// happened without needing to know this conversation makes several calls
// in sequence rather than one.
import { getSupabaseClient } from "../../lib/supabase.js";

export function buildChainedRunFileContent({ batchId, scenario, attempt, result, systemPrompt, initialUserMessage }) {
  const toolsCalled = result.toolsCalled.length;
  const totalTools = result.totalTools;
  const description = `Chained batch "${batchId}" — ${attempt.model} — real framing — style: ${attempt.style} — called ${toolsCalled}/${totalTools} tool(s)`;

  return {
    saved_at: new Date().toISOString(),
    scenario_id: scenario.scenario_id,
    scenario_title: scenario.title,
    framing: "real",
    direct_result: {
      accepted: toolsCalled === totalTools,
      tool_call: null,
      raw_text: [...result.turns].reverse().find((t) => t.role === "executor")?.text ?? "",
      framing: "real",
      truncated: [...result.turns].reverse().find((t) => t.role === "executor")?.truncated ?? false,
      turns: result.turns,
      messages: result.messages,
      argument_style: attempt.style,
      provider: "anthropic",
      model: attempt.model,
      total_cost: result.cost,
      system_prompt: systemPrompt,
      initial_user_message: initialUserMessage,
      tools_called: result.toolsCalled,
      total_tools: totalTools,
    },
    plan_result: null,
    steps: null,
    description,
    batch_id: batchId,
    run_kind: "chained",
    style: attempt.style,
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
