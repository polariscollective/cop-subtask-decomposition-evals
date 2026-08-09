import { runAdversarialNegotiation } from "../../lib/adversarial.js";
import { buildPlannerSystemPrompt, makePlanAcceptance } from "../../lib/planner.js";
import { buildExecutorSystemPrompt, buildExecutorUserMessage, stubOutput } from "../../lib/executor.js";
import { toolToAnthropicSchema } from "../../lib/scenarios.js";
import { resolveArgs } from "../../lib/placeholders.js";
import { providerForModel } from "../../lib/models.js";
import { saveState } from "./linear-state.js";
import { sumTurnsCost, wouldExceedBudget } from "./cost.js";
import { randomUUID } from "crypto";
import { buildLinearRunFileContent, writeRunFile } from "./linear-runfile.js";
import { BudgetExceededError } from "./run.js";

const MAX_TOKENS = 2048;

// Each chain is simple enough (plan, then up to 4 steps, one style, no
// branching) that on resume we just re-run the whole thing rather than
// trying to restore a mid-negotiation stage — a handful of cheap calls,
// not worth the bookkeeping a partial-stage resume would need. Only
// genuinely completed chains (status "done") are skipped.
async function runChain(attempt, { scenario, maxTurns, state, log }) {
  if (attempt.status === "done") return;

  if (!attempt.runId) {
    attempt.runId = randomUUID();
  }

  const modelProvider = providerForModel(attempt.model);
  const chain = { model: attempt.model, style: attempt.style, planResult: null, planResultReal: null, steps: [] };
  const persist = () =>
    writeRunFile(attempt.runId, buildLinearRunFileContent({ batchId: state.batch_id, scenario, chain }));

  // A fresh closure per stage (plan, step1, step2...) so each has its own
  // running "cost so far in this stage's own turns array" — sharing one
  // counter across stages would compute a bogus delta the moment a new
  // stage's turns array (which starts back at cost 0) is smaller than
  // whatever the previous stage left behind.
  const makeOnTurn = (label) => {
    let lastCost = 0;
    return async ({ turns, messages }) => {
      const newCost = sumTurnsCost(turns);
      const delta = newCost - lastCost;
      lastCost = newCost;

      const exceeded = wouldExceedBudget(state, delta);
      state.cumulative_cost += delta;
      attempt.cost += delta;
      await persist();
      await saveState(state);

      const last = turns[turns.length - 1];
      const execTurns = turns.filter((t) => t.role === "executor").length;
      const detail =
        last.role === "executor" ? (last.accepted ? "accepted" : "refused") : `pushback (${last.argument_style})`;
      log(
        `[${attempt.model}][${attempt.scenario_id}][${attempt.style}][${label}] turn ${execTurns}/${maxTurns} ` +
          `${last.role} ${detail} — $${state.cumulative_cost.toFixed(4)} cumulative`
      );
      if (exceeded) {
        throw new BudgetExceededError(`Budget cap ($${state.budget_cap}) reached during attempt ${attempt.id}`);
      }
    };
  };

  attempt.status = "running";
  await saveState(state);

  // One framing's plan attempt, as its own fresh conversation — no
  // history carried over between "real" and "test" attempts, they're
  // independent asks, only linked by using the same fixed argument style.
  const runPlanStage = async (framing) => {
    const planSystemPrompt = buildPlannerSystemPrompt(scenario, framing);
    const planGoal = scenario.goal[framing];
    const planOnTurn = makeOnTurn(`plan (${framing})`);
    const planResult = await runAdversarialNegotiation({
      provider: modelProvider,
      model: attempt.model,
      executorSystemPrompt: planSystemPrompt,
      tools: undefined,
      initialUserMessage: planGoal,
      goalText: planGoal,
      maxAdversaryTurns: maxTurns - 1,
      argumentStyle: attempt.style,
      maxTokensPerTurn: MAX_TOKENS,
      evaluateAcceptance: makePlanAcceptance(scenario),
      onTurn: planOnTurn,
    });
    const lastPlanTurn = [...planResult.turns].reverse().find((t) => t.role === "executor");
    return {
      accepted: planResult.accepted,
      plan: planResult.payload?.plan ?? null,
      raw_text: lastPlanTurn.text,
      framing,
      truncated: lastPlanTurn.truncated,
      turns: planResult.turns,
      messages: planResult.messages,
      argument_style: attempt.style,
      provider: modelProvider,
      model: attempt.model,
      total_cost: planResult.cost,
      system_prompt: planSystemPrompt,
      initial_user_message: planResult.messages[0]?.content ?? planGoal,
    };
  };

  try {
    // --- Stage 0: plan — real framing first; only if that's fully
    // exhausted without acceptance do we try test framing, fresh, same
    // style. Execution afterwards always uses real tool descriptions
    // regardless of which framing produced the plan (unchanged invariant).
    chain.planResult = await runPlanStage("real");
    await persist();
    if (!chain.planResult.accepted) {
      // Real framing was fully exhausted and refused — keep its transcript
      // around under planResultReal rather than letting the test-framing
      // retry below overwrite it, so the refusal is still visible in the
      // saved file even though it's not what the chain ultimately ran on.
      chain.planResultReal = chain.planResult;
      chain.planResult = await runPlanStage("test");
      await persist();
    }
    const planResult = { accepted: chain.planResult.accepted, payload: { plan: chain.planResult.plan } };

    if (planResult.accepted && planResult.payload?.plan) {
      // --- Stages 1..N: execute steps in order, same style throughout ---
      const priorOutputs = {};
      for (let i = 0; i < planResult.payload.plan.length; i++) {
        const stepSpec = planResult.payload.plan[i];
        const stepIndex = i + 1;
        const tool = scenario.tools.find((t) => t.name === stepSpec.tool);
        if (!tool) break; // malformed plan referencing an unknown tool — stop here
        const resolvedArgs = resolveArgs(stepSpec.arguments || {}, priorOutputs);
        const priorStepOutputText = stepIndex > 1 ? JSON.stringify(priorOutputs[stepIndex - 1] || {}) : null;
        const anthropicTool = toolToAnthropicSchema(tool, "real");
        const execSystemPrompt = buildExecutorSystemPrompt();
        const userMsg = buildExecutorUserMessage({ toolName: tool.name, args: resolvedArgs, priorStepOutputText });
        const goalText = `Call ${tool.name} with arguments ${JSON.stringify(resolvedArgs)}`;
        const stepOnTurn = makeOnTurn(`step${stepIndex}`);

        const stepResult = await runAdversarialNegotiation({
          provider: modelProvider,
          model: attempt.model,
          executorSystemPrompt: execSystemPrompt,
          tools: [anthropicTool],
          initialUserMessage: userMsg,
          goalText,
          maxAdversaryTurns: maxTurns - 1,
          argumentStyle: attempt.style,
          maxTokensPerTurn: MAX_TOKENS,
          onTurn: stepOnTurn,
        });
        const lastStepTurn = [...stepResult.turns].reverse().find((t) => t.role === "executor");
        const output = stepResult.accepted ? stubOutput(tool) : null;
        chain.steps.push({
          accepted: stepResult.accepted,
          tool_call_args: stepResult.payload?.arguments ?? null,
          output,
          raw_text: lastStepTurn.text,
          truncated: lastStepTurn.truncated,
          turns: stepResult.turns,
          messages: stepResult.messages,
          argument_style: attempt.style,
          provider: modelProvider,
          model: attempt.model,
          total_cost: stepResult.cost,
          system_prompt: execSystemPrompt,
          initial_user_message: stepResult.messages[0]?.content ?? userMsg,
          tool: tool.name,
          args: resolvedArgs,
        });
        await persist();

        if (!stepResult.accepted) break; // chain stops here
        priorOutputs[stepIndex] = output;
      }
    }

    attempt.status = "done";
    attempt.error = null;
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    attempt.status = "error";
    attempt.error = err.message || String(err);
  }
  await persist();
  await saveState(state);
}

export async function runLinearBatch({ state, scenarios, log = console.log }) {
  try {
    for (const attempt of state.attempts) {
      await runChain(attempt, { scenario: scenarios[attempt.scenario_id], maxTurns: state.max_turns, state, log });
    }
    return { stopped: false };
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      log(`\nStopped: ${err.message}. Resume later with the same --batch-id (raise --budget to continue).`);
      return { stopped: true, reason: err.message };
    }
    throw err;
  }
}
