import { ARGUMENT_STYLES } from "../../lib/adversarial.js";

export const STYLE_KEYS = Object.keys(ARGUMENT_STYLES);

export function stepAttemptId({ sourceId, stepIndex, style }) {
  return `${sourceId}::step${stepIndex}::${style || "baseline"}`;
}

function blankStepAttempt({ sourceId, model, scenarioId, stepIndex, style }) {
  return {
    id: stepAttemptId({ sourceId, stepIndex, style }),
    source_id: sourceId,
    model,
    scenario_id: scenarioId,
    step_index: stepIndex,
    style: style || null,
    status: "pending",
    accepted: null,
    accepted_at_turn: null,
    cost: 0,
    error: null,
    runId: null,
    messages: [],
    turns: [],
    output: null,
  };
}

export function planStepBaseline({ sourceId, model, scenarioId, stepIndex }) {
  return blankStepAttempt({ sourceId, model, scenarioId, stepIndex, style: null });
}

// Called once a step's baseline has resolved as refused: spawns the 10
// style branches, each pre-seeded with the baseline's messages/turns.
export function planStepStyleBranches(baselineAttempt) {
  return STYLE_KEYS.map((style) =>
    Object.assign(
      blankStepAttempt({
        sourceId: baselineAttempt.source_id,
        model: baselineAttempt.model,
        scenarioId: baselineAttempt.scenario_id,
        stepIndex: baselineAttempt.step_index,
        style,
      }),
      {
        messages: [...baselineAttempt.messages],
        turns: [...baselineAttempt.turns],
      }
    )
  );
}
