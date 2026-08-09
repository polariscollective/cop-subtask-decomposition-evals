import { randomUUID } from "crypto";
import { runChainedToolSequence } from "../../lib/chained.js";
import { saveState } from "./chained-state.js";
import { sumTurnsCost, wouldExceedBudget } from "./cost.js";
import { buildChainedRunFileContent, writeRunFile } from "./chained-runfile.js";
import { BudgetExceededError } from "./run.js";

async function runAttempt(attempt, { scenario, maxTurns, state, log }) {
  if (attempt.status === "done") return;

  if (!attempt.runId) {
    attempt.runId = randomUUID();
  }

  let lastCost = 0;
  let latestResult = { toolsCalled: [], totalTools: scenario.tools.length, turns: [], messages: [], cost: 0 };
  const goalText = scenario.goal.real;
  const persist = () =>
    writeRunFile(
      attempt.runId,
      buildChainedRunFileContent({
        batchId: state.batch_id,
        scenario,
        attempt,
        result: latestResult,
        systemPrompt: undefined,
        initialUserMessage: goalText,
      })
    );

  const onTurn = async ({ turns, messages }) => {
    latestResult = { ...latestResult, turns, messages };
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
      last.role === "executor" ? (last.accepted ? "called a tool" : "refused") : `pushback (${last.argument_style})`;
    log(
      `[${attempt.model}][${attempt.scenario_id}][${attempt.style}][chained] turn ${execTurns}/${maxTurns} ` +
        `${last.role} ${detail} — $${state.cumulative_cost.toFixed(4)} cumulative`
    );
    if (exceeded) {
      throw new BudgetExceededError(`Budget cap ($${state.budget_cap}) reached during attempt ${attempt.id}`);
    }
  };

  attempt.status = "running";
  await saveState(state);

  try {
    const result = await runChainedToolSequence({
      model: attempt.model,
      scenario,
      argumentStyle: attempt.style,
      maxTurns,
      onTurn,
    });
    latestResult = result;
    await persist();
    attempt.status = "done";
    attempt.error = null;
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    attempt.status = "error";
    attempt.error = err.message || String(err);
    await persist();
  }
  await saveState(state);
}

export async function runChainedBatch({ state, scenarios, log = console.log }) {
  try {
    for (const attempt of state.attempts) {
      await runAttempt(attempt, { scenario: scenarios[attempt.scenario_id], maxTurns: state.max_turns, state, log });
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
