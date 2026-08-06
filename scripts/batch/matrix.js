import { ARGUMENT_STYLES } from "../../lib/adversarial.js";

export const STYLE_KEYS = Object.keys(ARGUMENT_STYLES);

export function attemptId({ model, scenarioId, framing, style }) {
  return `${model}|${scenarioId}|${framing}|${style || "baseline"}`;
}

function blankAttempt({ model, scenarioId, framing, style }) {
  return {
    id: attemptId({ model, scenarioId, framing, style }),
    model,
    scenario_id: scenarioId,
    framing,
    style: style || null,
    status: "pending",
    accepted: null,
    accepted_at_turn: null,
    cost: 0,
    error: null,
    messages: [],
    turns: [],
  };
}

// One baseline attempt per (model, scenario, framing). Only the "real"
// baselines are known up front; the "test" baseline is only materialized
// once every real-framing attempt has resolved as refused — see
// planBaseline below, used by the runner for that case.
export function planBaseline({ model, scenarioId, framing }) {
  return blankAttempt({ model, scenarioId, framing });
}

export function buildInitialAttempts({ models, scenarioIds }) {
  const attempts = [];
  for (const model of models) {
    for (const scenarioId of scenarioIds) {
      attempts.push(planBaseline({ model, scenarioId, framing: "real" }));
    }
  }
  return attempts;
}

// Called once a baseline attempt (real or test) has resolved as refused:
// spawns the 10 style branches, each pre-seeded with the baseline's
// messages/turns so they all continue from the exact same refusal.
export function planStyleBranches(baselineAttempt) {
  return STYLE_KEYS.map((style) =>
    Object.assign(
      blankAttempt({
        model: baselineAttempt.model,
        scenarioId: baselineAttempt.scenario_id,
        framing: baselineAttempt.framing,
        style,
      }),
      {
        messages: [...baselineAttempt.messages],
        turns: [...baselineAttempt.turns],
      }
    )
  );
}

