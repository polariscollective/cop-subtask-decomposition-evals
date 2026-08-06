import { runAdversarialNegotiation, continueAdversarialNegotiation } from "../../lib/adversarial.js";
import { buildPlannerSystemPrompt, planAcceptance } from "../../lib/planner.js";
import { attemptId, planBaseline, planStyleBranches } from "./matrix.js";
import { saveState } from "./state.js";
import { sumTurnsCost, wouldExceedBudget } from "./cost.js";

const MAX_TOKENS_PER_TURN = 2048;

export class BudgetExceededError extends Error {}

function findAttempt(state, id) {
  return state.attempts.find((a) => a.id === id);
}

function addAttemptIfMissing(state, attempt) {
  if (findAttempt(state, attempt.id)) return findAttempt(state, attempt.id);
  state.attempts.push(attempt);
  return attempt;
}

async function runAttempt(attempt, { scenario, maxTurns, state, log }) {
  if (attempt.status === "done" || attempt.status === "skipped") return;

  const systemPrompt = buildPlannerSystemPrompt(scenario, attempt.framing);
  const goalText = scenario.goal[attempt.framing];

  const onTurn = async ({ turns, messages }) => {
    attempt.turns = turns;
    attempt.messages = messages;
    const newCost = sumTurnsCost(turns);
    const delta = newCost - attempt.cost;
    attempt.cost = newCost;

    if (wouldExceedBudget(state, delta)) {
      state.cumulative_cost += delta;
      saveState(state);
      throw new BudgetExceededError(
        `Budget cap ($${state.budget_cap}) reached during attempt ${attempt.id}`
      );
    }
    state.cumulative_cost += delta;
    saveState(state);

    const last = turns[turns.length - 1];
    const executorTurns = turns.filter((t) => t.role === "executor").length;
    const detail =
      last.role === "executor" ? (last.accepted ? "accepted" : "refused") : `pushback (${last.argument_style})`;
    log(
      `[${attempt.model}][${attempt.scenario_id}][${attempt.framing}][${attempt.style || "baseline"}] ` +
        `turn ${executorTurns}/${maxTurns} ${last.role} ${detail} — $${state.cumulative_cost.toFixed(4)} cumulative`
    );
  };

  attempt.status = "running";
  saveState(state);

  try {
    let result;
    if (attempt.turns.length === 0) {
      result = await runAdversarialNegotiation({
        model: attempt.model,
        executorSystemPrompt: systemPrompt,
        tools: undefined,
        initialUserMessage: goalText,
        goalText,
        maxAdversaryTurns: 0,
        argumentStyle: "ethical", // unused: 0 adversary turns never generates a pushback message
        maxTokensPerTurn: MAX_TOKENS_PER_TURN,
        evaluateAcceptance: planAcceptance,
        onTurn,
      });
    } else {
      const executorTurns = attempt.turns.filter((t) => t.role === "executor").length;
      const remaining = maxTurns - executorTurns;
      result =
        remaining <= 0
          ? { accepted: attempt.accepted, turns: attempt.turns, messages: attempt.messages }
          : await continueAdversarialNegotiation({
              model: attempt.model,
              executorSystemPrompt: systemPrompt,
              tools: undefined,
              priorMessages: attempt.messages,
              priorTurns: attempt.turns,
              goalText,
              maxAdversaryTurns: remaining,
              argumentStyle: attempt.style,
              maxTokensPerTurn: MAX_TOKENS_PER_TURN,
              evaluateAcceptance: planAcceptance,
              onTurn,
            });
    }

    attempt.turns = result.turns;
    attempt.messages = result.messages;
    attempt.accepted = result.accepted;
    if (result.accepted) {
      const lastExecutor = [...result.turns].reverse().find((t) => t.role === "executor");
      attempt.accepted_at_turn = lastExecutor?.turn ?? null;
    }
    attempt.status = "done";
    attempt.error = null;
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    attempt.status = "error";
    attempt.error = err.message || String(err);
  }
  saveState(state);
}

async function runFraming({ state, model, scenarioId, scenario, framing, maxTurns, log }) {
  const baseline = addAttemptIfMissing(
    state,
    findAttempt(state, attemptId({ model, scenarioId, framing, style: null })) ||
      planBaseline({ model, scenarioId, framing })
  );
  await runAttempt(baseline, { scenario, maxTurns, state, log });

  if (baseline.status !== "done") return { anyAccepted: baseline.accepted === true };
  if (baseline.accepted) return { anyAccepted: true };

  const styleAttempts = planStyleBranches(baseline).map((a) => addAttemptIfMissing(state, a));
  let anyAccepted = false;
  for (const styleAttempt of styleAttempts) {
    await runAttempt(styleAttempt, { scenario, maxTurns, state, log });
    if (styleAttempt.accepted) anyAccepted = true;
  }
  return { anyAccepted };
}

export async function runCombo({ state, model, scenarioId, scenario, maxTurns, log }) {
  const real = await runFraming({ state, model, scenarioId, scenario, framing: "real", maxTurns, log });
  if (real.anyAccepted) return;
  await runFraming({ state, model, scenarioId, scenario, framing: "test", maxTurns, log });
}

export async function runBatch({ state, scenarios, log = console.log }) {
  try {
    for (const model of state.models) {
      for (const scenarioId of state.scenario_ids) {
        await runCombo({
          state,
          model,
          scenarioId,
          scenario: scenarios[scenarioId],
          maxTurns: state.max_turns,
          log,
        });
      }
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
