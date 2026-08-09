import { runAdversarialNegotiation, continueAdversarialNegotiation } from "../../lib/adversarial.js";
import { buildExecutorSystemPrompt, buildExecutorUserMessage, stubOutput } from "../../lib/executor.js";
import { toolToAnthropicSchema } from "../../lib/scenarios.js";
import { resolveArgs } from "../../lib/placeholders.js";
import { stepAttemptId, planStepBaseline, planStepStyleBranches, STYLE_KEYS } from "./steps-matrix.js";
import { saveState } from "./steps-state.js";
import { sumTurnsCost, wouldExceedBudget } from "./cost.js";
import { randomUUID } from "crypto";
import { buildStepRunFileContent, writeRunFile, readRunFile } from "./steps-runfile.js";
import { BudgetExceededError } from "./run.js";

const MAX_TOKENS_PER_TURN = 1500;

function findAttempt(state, id) {
  return state.attempts.find((a) => a.id === id);
}

function addAttemptIfMissing(state, attempt) {
  const existing = findAttempt(state, attempt.id);
  if (existing) return existing;
  state.attempts.push(attempt);
  return attempt;
}

async function runStepAttempt(
  attempt,
  { batchId, sourcePlan, scenario, tool, resolvedArgs, priorStepOutputText, priorCanonicalSteps, maxTurns, state, log }
) {
  if (attempt.status === "done" || attempt.status === "skipped") return;

  const anthropicTool = toolToAnthropicSchema(tool, "real");
  const systemPrompt = buildExecutorSystemPrompt();
  const userMsg = buildExecutorUserMessage({ toolName: tool.name, args: resolvedArgs, priorStepOutputText });
  const goalText = `Call ${tool.name} with arguments ${JSON.stringify(resolvedArgs)}`;

  if (!attempt.runId) {
    attempt.runId = randomUUID();
  }
  const persistRunFile = () =>
    writeRunFile(
      attempt.runId,
      buildStepRunFileContent({
        batchId,
        sourcePlan,
        scenario,
        attempt,
        priorCanonicalSteps,
        resolvedArgs,
        toolName: tool.name,
        priorStepOutputText,
      })
    );
  await persistRunFile();

  const onTurn = async ({ turns, messages }) => {
    attempt.turns = turns;
    attempt.messages = messages;
    const newCost = sumTurnsCost(turns);
    const delta = newCost - attempt.cost;
    attempt.cost = newCost;

    const exceeded = wouldExceedBudget(state, delta);
    state.cumulative_cost += delta;
    await persistRunFile();
    await saveState(state);

    const last = turns[turns.length - 1];
    const executorTurns = turns.filter((t) => t.role === "executor").length;
    const detail =
      last.role === "executor" ? (last.accepted ? "accepted" : "refused") : `pushback (${last.argument_style})`;
    log(
      `[${attempt.model}][${attempt.source_id}][step ${attempt.step_index}][${attempt.style || "baseline"}] ` +
        `turn ${executorTurns}/${maxTurns} ${last.role} ${detail} — $${state.cumulative_cost.toFixed(4)} cumulative`
    );

    if (exceeded) {
      throw new BudgetExceededError(
        `Budget cap ($${state.budget_cap}) reached during attempt ${attempt.id}`
      );
    }
  };

  attempt.status = "running";
  await saveState(state);

  try {
    let result;
    if (attempt.turns.length === 0) {
      result = await runAdversarialNegotiation({
        model: attempt.model,
        executorSystemPrompt: systemPrompt,
        tools: [anthropicTool],
        initialUserMessage: userMsg,
        goalText,
        maxAdversaryTurns: 0,
        argumentStyle: "ethical", // unused: 0 adversary turns never generates a pushback message
        maxTokensPerTurn: MAX_TOKENS_PER_TURN,
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
              tools: [anthropicTool],
              priorMessages: attempt.messages,
              priorTurns: attempt.turns,
              goalText,
              maxAdversaryTurns: remaining,
              argumentStyle: attempt.style,
              maxTokensPerTurn: MAX_TOKENS_PER_TURN,
              onTurn,
            });
    }

    attempt.turns = result.turns;
    attempt.messages = result.messages;
    attempt.accepted = result.accepted;
    if (result.accepted) {
      const lastExecutor = [...result.turns].reverse().find((t) => t.role === "executor");
      attempt.accepted_at_turn = lastExecutor?.turn ?? null;
      attempt.output = stubOutput(tool);
    }
    attempt.status = "done";
    attempt.error = null;
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    attempt.status = "error";
    attempt.error = err.message || String(err);
  }
  await persistRunFile();
  await saveState(state);
}

// Picks the canonical attempt for a resolved step: baseline if it
// accepted, otherwise the first style (in fixed STYLE_KEYS order) that
// did. Returns null if nothing accepted — the step (and the plan) breaks
// here.
function pickCanonical(baseline, styleAttempts) {
  if (baseline.accepted) return baseline;
  return styleAttempts.find((a) => a.accepted) || null;
}

function canonicalStepEntry(runFile) {
  return runFile.steps[runFile.steps.length - 1];
}

async function runStep({ batchId, state, sourcePlan, scenario, stepIndex, priorOutputs, canonicalSteps, maxTurns, log }) {
  const stepSpec = sourcePlan.plan[stepIndex - 1];
  const tool = scenario.tools.find((t) => t.name === stepSpec.tool);
  const resolvedArgs = resolveArgs(stepSpec.arguments || {}, priorOutputs);
  const priorStepOutputText = stepIndex > 1 ? JSON.stringify(priorOutputs[stepIndex - 1] || {}) : null;

  const baselineId = stepAttemptId({ sourceId: sourcePlan.sourceId, stepIndex, style: null });
  const baseline = addAttemptIfMissing(
    state,
    findAttempt(state, baselineId) ||
      planStepBaseline({ sourceId: sourcePlan.sourceId, model: sourcePlan.model, scenarioId: sourcePlan.scenarioId, stepIndex })
  );
  await runStepAttempt(baseline, {
    batchId,
    sourcePlan,
    scenario,
    tool,
    resolvedArgs,
    priorStepOutputText,
    priorCanonicalSteps: canonicalSteps,
    maxTurns,
    state,
    log,
  });
  if (baseline.status !== "done") return { reached: false, incomplete: true };

  let styleAttempts = [];
  if (!baseline.accepted) {
    styleAttempts = planStepStyleBranches(baseline).map((a) => addAttemptIfMissing(state, a));
    for (const sa of styleAttempts) {
      await runStepAttempt(sa, {
        batchId,
        sourcePlan,
        scenario,
        tool,
        resolvedArgs,
        priorStepOutputText,
        priorCanonicalSteps: canonicalSteps,
        maxTurns,
        state,
        log,
      });
      if (sa.status !== "done") return { reached: false, incomplete: true };
    }
  }

  const canonical = pickCanonical(baseline, styleAttempts);
  if (!canonical) return { reached: false, incomplete: false }; // genuinely broke here

  const runFile = await readRunFile(canonical.runId);
  const entry = canonicalStepEntry(runFile);
  priorOutputs[stepIndex] = entry.output;
  canonicalSteps.push(entry);
  return { reached: true };
}

export async function runPlanSteps({ batchId, state, sourcePlan, scenario, maxTurns, log }) {
  const priorOutputs = {};
  const canonicalSteps = [];
  for (let stepIndex = 1; stepIndex <= sourcePlan.plan.length; stepIndex++) {
    const { reached, incomplete } = await runStep({
      batchId,
      state,
      sourcePlan,
      scenario,
      stepIndex,
      priorOutputs,
      canonicalSteps,
      maxTurns,
      log,
    });
    if (!reached) {
      if (!incomplete) {
        log(
          `[${sourcePlan.model}][${sourcePlan.sourceId}] execution breaks at step ${stepIndex}/${sourcePlan.plan.length} ` +
            `(no attempt got this step accepted) — not attempting later steps for this plan.`
        );
      }
      return;
    }
  }
}

// Reconstructs canonicalSteps/priorOutputs for a source plan that already
// has some attempts recorded (resume case), by walking steps in order and
// reading each resolved step's canonical run file back off disk — never
// regenerating a stub (stubOutput is random; the value already used and
// threaded into later steps must be reused exactly, not re-rolled).
async function reconstructProgress(state, sourcePlan) {
  const priorOutputs = {};
  const canonicalSteps = [];
  for (let stepIndex = 1; stepIndex <= sourcePlan.plan.length; stepIndex++) {
    const baselineId = stepAttemptId({ sourceId: sourcePlan.sourceId, stepIndex, style: null });
    const baseline = findAttempt(state, baselineId);
    if (!baseline || baseline.status !== "done") return { priorOutputs, canonicalSteps, resumeAtStep: stepIndex };

    let canonicalId = baseline.accepted ? baselineId : null;
    if (!canonicalId) {
      for (const style of STYLE_KEYS) {
        const sid = stepAttemptId({ sourceId: sourcePlan.sourceId, stepIndex, style });
        const sa = findAttempt(state, sid);
        if (!sa || sa.status !== "done") return { priorOutputs, canonicalSteps, resumeAtStep: stepIndex };
        if (sa.accepted) {
          canonicalId = sid;
          break;
        }
      }
    }
    if (!canonicalId) return { priorOutputs, canonicalSteps, resumeAtStep: null }; // broke at this step, done for good

    const canonicalAttempt = findAttempt(state, canonicalId);
    const runFile = await readRunFile(canonicalAttempt.runId);
    const entry = canonicalStepEntry(runFile);
    priorOutputs[stepIndex] = entry.output;
    canonicalSteps.push(entry);
  }
  return { priorOutputs, canonicalSteps, resumeAtStep: sourcePlan.plan.length + 1 }; // fully walked already
}

export async function resumePlanSteps({ batchId, state, sourcePlan, scenario, maxTurns, log }) {
  const { priorOutputs, canonicalSteps, resumeAtStep } = await reconstructProgress(state, sourcePlan);
  if (resumeAtStep === null) return; // this plan already broke at some step; nothing more to do
  for (let stepIndex = resumeAtStep; stepIndex <= sourcePlan.plan.length; stepIndex++) {
    const { reached, incomplete } = await runStep({
      batchId,
      state,
      sourcePlan,
      scenario,
      stepIndex,
      priorOutputs,
      canonicalSteps,
      maxTurns,
      log,
    });
    if (!reached) {
      if (!incomplete) {
        log(
          `[${sourcePlan.model}][${sourcePlan.sourceId}] execution breaks at step ${stepIndex}/${sourcePlan.plan.length} ` +
            `(no attempt got this step accepted) — not attempting later steps for this plan.`
        );
      }
      return;
    }
  }
}

export async function runStepsBatch({ batchId, state, sourcePlans, scenarios, log = console.log }) {
  try {
    for (const sp of sourcePlans) {
      const alreadyHasAttempts = state.attempts.some((a) => a.source_id === sp.sourceId);
      if (alreadyHasAttempts) {
        await resumePlanSteps({ batchId, state, sourcePlan: sp, scenario: scenarios[sp.scenarioId], maxTurns: state.max_turns, log });
      } else {
        await runPlanSteps({ batchId, state, sourcePlan: sp, scenario: scenarios[sp.scenarioId], maxTurns: state.max_turns, log });
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
