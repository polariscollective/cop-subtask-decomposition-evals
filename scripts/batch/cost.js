import { costForCall, providerForModel } from "../../lib/models.js";
import { STYLE_KEYS } from "./matrix.js";

// Rough, deliberately conservative token assumptions for the pre-flight
// worst-case estimate. Not a simulation of the real conversation growth —
// just enough to give an upper bound to confirm before spending real money.
// See docs/superpowers/specs/2026-08-05-batch-eval-design.md.
const ASSUMED_EXECUTOR_INPUT_TOKENS = 3000;
const ASSUMED_EXECUTOR_OUTPUT_TOKENS = 2048; // matches maxTokensPerTurn in app/api/plan
const ASSUMED_ADVERSARY_INPUT_TOKENS = 600;
const ASSUMED_ADVERSARY_OUTPUT_TOKENS = 400;
// The adversary is always played by this model regardless of which model
// is under evaluation — see lib/adversarial.js's adversaryModel default.
const ADVERSARY_MODEL = "claude-sonnet-5";

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
      provider: providerForModel(model),
      model,
      inputTokens: ASSUMED_EXECUTOR_INPUT_TOKENS,
      outputTokens: ASSUMED_EXECUTOR_OUTPUT_TOKENS,
    });
  // The adversary is always Anthropic Sonnet regardless of the executor's
  // own provider — see lib/adversarial.js's adversaryProvider default.
  const adversaryCost =
    adversaryCalls *
    costForCall({
      provider: "anthropic",
      model: ADVERSARY_MODEL,
      inputTokens: ASSUMED_ADVERSARY_INPUT_TOKENS,
      outputTokens: ASSUMED_ADVERSARY_OUTPUT_TOKENS,
    });
  return executorCost + adversaryCost;
}

function baselineWorstCaseCost(model) {
  return costForCall({
    provider: providerForModel(model),
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

// Absolute worst case for step execution: every step of every source plan
// runs baseline + 10 styles and none ever gets accepted (so every plan's
// steps are all attempted — in reality a plan stops at its first
// never-accepted step, which is usually far cheaper).
export function estimateStepsWorstCase({ sourcePlans, maxTurns }) {
  const perPlan = sourcePlans.map((sp) => {
    const baselineCost = baselineWorstCaseCost(sp.model) * sp.plan.length;
    const stylesCost = styleBranchWorstCaseCost(sp.model, maxTurns) * STYLE_KEYS.length * sp.plan.length;
    return { sourceId: sp.sourceId, model: sp.model, steps: sp.plan.length, cost: baselineCost + stylesCost };
  });
  const totalUsd = perPlan.reduce((sum, p) => sum + p.cost, 0);
  return { totalUsd, perPlan };
}

// Cost of one fully-exhausted stage on its own (a plan ask, or one
// execute-step ask) starting from zero turns: up to maxTurns executor
// calls plus maxTurns-1 adversary calls, single fixed style throughout.
function oneStageWorstCaseCost(model, maxTurns) {
  return baselineWorstCaseCost(model) + styleBranchWorstCaseCost(model, maxTurns);
}

// Worst case for the linear (single-style, no branching) pipeline: plan
// under real framing, then (if that's fully exhausted unaccepted) plan
// again fresh under test framing, then up to 4 execute stages — each
// possibly fully exhausted, for every (model, scenario, style) combination.
export function estimateLinearWorstCase({ models, scenarioIds, styles, maxTurns, stepsPerScenario }) {
  const perAttempt = [];
  for (const model of models) {
    for (const scenarioId of scenarioIds) {
      const stages = 2 + (stepsPerScenario[scenarioId] || 4); // plan (real) + plan (test) + steps
      const cost = oneStageWorstCaseCost(model, maxTurns) * stages;
      for (const style of styles) perAttempt.push({ model, scenarioId, style, cost });
    }
  }
  const totalUsd = perAttempt.reduce((sum, a) => sum + a.cost, 0);
  return { totalUsd, perAttempt };
}

// Worst case for the chained (single conversation, direct multi-tool-call)
// pipeline: one tool-slot negotiation per tool in the scenario, each
// possibly fully exhausted, no separate plan stage.
export function estimateChainedWorstCase({ models, scenarioIds, styles, maxTurns, toolsPerScenario }) {
  const perAttempt = [];
  for (const model of models) {
    for (const scenarioId of scenarioIds) {
      const stages = toolsPerScenario[scenarioId] || 4;
      const cost = oneStageWorstCaseCost(model, maxTurns) * stages;
      for (const style of styles) perAttempt.push({ model, scenarioId, style, cost });
    }
  }
  const totalUsd = perAttempt.reduce((sum, a) => sum + a.cost, 0);
  return { totalUsd, perAttempt };
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
