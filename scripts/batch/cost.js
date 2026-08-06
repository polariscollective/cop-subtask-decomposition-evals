import { costForCall } from "../../lib/models.js";
import { STYLE_KEYS } from "./matrix.js";

// Rough, deliberately conservative token assumptions for the pre-flight
// worst-case estimate. Not a simulation of the real conversation growth —
// just enough to give an upper bound to confirm before spending real money.
// See docs/superpowers/specs/2026-08-05-batch-eval-design.md.
const ASSUMED_EXECUTOR_INPUT_TOKENS = 3000;
const ASSUMED_EXECUTOR_OUTPUT_TOKENS = 2048; // matches maxTokensPerTurn in app/api/plan
const ASSUMED_ADVERSARY_INPUT_TOKENS = 600;
const ASSUMED_ADVERSARY_OUTPUT_TOKENS = 400;

// New executor/adversary calls a single style branch makes in the worst
// case (never accepted), given it starts from a 1-turn baseline and is
// pushed to maxTurns total executor turns. See design doc's "turn budget
// math" section for the derivation.
function callsPerStyleBranch(maxTurns) {
  const m = maxTurns - 1; // remaining turns after the shared baseline
  return { executorCalls: m, adversaryCalls: m };
}

function styleBranchWorstCaseCost(model, maxTurns) {
  const { executorCalls, adversaryCalls } = callsPerStyleBranch(maxTurns);
  const executorCost =
    executorCalls *
    costForCall({
      provider: "anthropic",
      model,
      inputTokens: ASSUMED_EXECUTOR_INPUT_TOKENS,
      outputTokens: ASSUMED_EXECUTOR_OUTPUT_TOKENS,
    });
  const adversaryCost =
    adversaryCalls *
    costForCall({
      provider: "anthropic",
      model,
      inputTokens: ASSUMED_ADVERSARY_INPUT_TOKENS,
      outputTokens: ASSUMED_ADVERSARY_OUTPUT_TOKENS,
    });
  return executorCost + adversaryCost;
}

function baselineWorstCaseCost(model) {
  return costForCall({
    provider: "anthropic",
    model,
    inputTokens: ASSUMED_EXECUTOR_INPUT_TOKENS,
    outputTokens: ASSUMED_EXECUTOR_OUTPUT_TOKENS,
  });
}

// Absolute worst case: nothing is ever accepted anywhere, so every combo
// runs baseline + 10 styles under BOTH framings (real, then test).
export function estimateWorstCase({ models, scenarioIds, maxTurns }) {
  const perCombo = models.flatMap((model) =>
    scenarioIds.map((scenarioId) => {
      const framings = 2; // real + test, worst case both are fully exhausted
      const baselineCost = baselineWorstCaseCost(model) * framings;
      const stylesCost = styleBranchWorstCaseCost(model, maxTurns) * STYLE_KEYS.length * framings;
      return { model, scenarioId, cost: baselineCost + stylesCost };
    })
  );
  const totalUsd = perCombo.reduce((sum, c) => sum + c.cost, 0);
  return { totalUsd, perCombo };
}

export function sumTurnsCost(turns) {
  return turns.reduce((sum, t) => sum + (t.cost || 0), 0);
}

// Returns true if recording `additionalCost` would push cumulative spend
// past the batch's budget cap (null/undefined cap means uncapped).
export function wouldExceedBudget(state, additionalCost) {
  if (state.budget_cap == null) return false;
  return state.cumulative_cost + additionalCost > state.budget_cap;
}
