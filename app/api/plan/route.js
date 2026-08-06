import { NextResponse } from "next/server";
import { loadScenario } from "../../../lib/scenarios";
import { runAdversarialNegotiation, continueAdversarialNegotiation } from "../../../lib/adversarial";
import { buildPlannerSystemPrompt, planAcceptance } from "../../../lib/planner";

export async function POST(req) {
  const {
    scenarioId,
    framing,
    adversaryTurns = 0,
    argumentStyle = "all",
    continueFrom,
    provider = "anthropic",
    model,
  } = await req.json(); // framing: "real" | "test"
  const scenario = loadScenario(scenarioId);
  const systemPrompt = buildPlannerSystemPrompt(scenario, framing);
  const userGoal = scenario.goal[framing];
  const resolvedModel = model || "claude-sonnet-4-6";

  let result;
  try {
    result = continueFrom
      ? await continueAdversarialNegotiation({
          provider,
          model: resolvedModel,
          executorSystemPrompt: systemPrompt,
          tools: undefined,
          priorMessages: continueFrom.messages,
          priorTurns: continueFrom.turns,
          goalText: userGoal,
          maxAdversaryTurns: Math.max(1, Math.min(20, adversaryTurns)),
          argumentStyle,
          maxTokensPerTurn: 2048,
          evaluateAcceptance: planAcceptance,
        })
      : await runAdversarialNegotiation({
          provider,
          model: resolvedModel,
          executorSystemPrompt: systemPrompt,
          tools: undefined,
          initialUserMessage: userGoal,
          goalText: userGoal,
          maxAdversaryTurns: Math.max(0, Math.min(20, adversaryTurns)),
          argumentStyle,
          maxTokensPerTurn: 2048,
          evaluateAcceptance: planAcceptance,
        });
  } catch (err) {
    return NextResponse.json({
      accepted: false,
      plan: null,
      raw_text: `API call failed: ${err.message || err}`,
      framing,
      turns: continueFrom?.turns || [],
      messages: continueFrom?.messages || [],
    });
  }

  const lastExecutorTurn = [...result.turns].reverse().find((t) => t.role === "executor");

  return NextResponse.json({
    accepted: result.accepted,
    plan: result.payload?.plan ?? null,
    raw_text: lastExecutorTurn.text,
    framing,
    truncated: lastExecutorTurn.truncated,
    turns: result.turns,
    messages: result.messages,
    argument_style: argumentStyle,
    provider,
    model: resolvedModel,
    total_cost: result.cost,
    system_prompt: systemPrompt,
    initial_user_message: result.messages[0]?.content ?? userGoal,
  });
}
