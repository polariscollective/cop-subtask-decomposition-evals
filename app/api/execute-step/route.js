import { NextResponse } from "next/server";
import { loadScenario, toolToAnthropicSchema } from "../../../lib/scenarios";
import { runAdversarialNegotiation, continueAdversarialNegotiation } from "../../../lib/adversarial";
import { buildExecutorSystemPrompt, buildExecutorUserMessage, stubOutput } from "../../../lib/executor";

export async function POST(req) {
  const {
    scenarioId,
    toolName,
    args,
    priorStepOutputText,
    adversaryTurns = 0,
    argumentStyle = "all",
    continueFrom,
    provider = "anthropic",
    model,
  } = await req.json();
  const scenario = await loadScenario(scenarioId);
  const tool = scenario.tools.find((t) => t.name === toolName);
  if (!tool) return NextResponse.json({ error: "unknown tool" }, { status: 400 });

  // Executor is "blind": no memory of the overall plan or goal, only the
  // concrete step to perform and the previous step's output as context.
  // ALWAYS the real tool description, regardless of planning framing.
  const anthropicTool = toolToAnthropicSchema(tool, "real");

  const systemPrompt = buildExecutorSystemPrompt();
  const userMsg = buildExecutorUserMessage({ toolName, args, priorStepOutputText });

  const goalText = `Call ${toolName} with arguments ${JSON.stringify(args)}`;
  const resolvedModel = model || "claude-sonnet-4-6";

  let result;
  try {
    result = continueFrom
      ? await continueAdversarialNegotiation({
          provider,
          model: resolvedModel,
          executorSystemPrompt: systemPrompt,
          tools: [anthropicTool],
          priorMessages: continueFrom.messages,
          priorTurns: continueFrom.turns,
          goalText,
          maxAdversaryTurns: Math.max(1, Math.min(20, adversaryTurns)),
          argumentStyle,
        })
      : await runAdversarialNegotiation({
          provider,
          model: resolvedModel,
          executorSystemPrompt: systemPrompt,
          tools: [anthropicTool],
          initialUserMessage: userMsg,
          goalText,
          maxAdversaryTurns: Math.max(0, Math.min(20, adversaryTurns)),
          argumentStyle,
        });
  } catch (err) {
    const errorText = `API call failed: ${err.message || err}`;
    const priorTurns = continueFrom?.turns || [];
    const nextTurnNumber = priorTurns.length ? priorTurns[priorTurns.length - 1].turn + 1 : 1;
    return NextResponse.json({
      accepted: false,
      output: null,
      raw_text: errorText,
      turns: [
        ...priorTurns,
        { turn: nextTurnNumber, role: "executor", accepted: false, text: errorText, payload: null },
      ],
      messages: continueFrom?.messages || [],
      system_prompt: systemPrompt,
      initial_user_message: continueFrom?.messages?.[0]?.content ?? userMsg,
    });
  }

  const lastExecutorTurn = [...result.turns].reverse().find((t) => t.role === "executor");

  return NextResponse.json({
    accepted: result.accepted,
    tool_call_args: result.payload?.arguments ?? null,
    output: result.accepted ? stubOutput(tool) : null,
    raw_text: lastExecutorTurn.text,
    truncated: lastExecutorTurn.truncated,
    turns: result.turns,
    messages: result.messages,
    argument_style: argumentStyle,
    provider,
    model: resolvedModel,
    total_cost: result.cost,
    // Exact executor input, for verification — the system prompt is
    // constant for the whole negotiation; the initial user message is read
    // back from messages[0] so it's correct even after a "continue".
    system_prompt: systemPrompt,
    initial_user_message: result.messages[0]?.content ?? userMsg,
  });
}
