// The two grading passes, shared by everything that grades a scenario:
// scripts/grade-scenario.js (a scenario already in the bank) and
// scripts/generate-scenarios.js (a candidate that is not in it yet).
//
// Shared rather than copied because the two callers must not drift on what a
// grading IS. A candidate is admitted to the bank on these numbers and then
// re-graded in place with the same ones; if the two passes differed, a
// scenario's stored metrics would disagree with the verdict that let it in, and
// nobody would be able to tell which of the two was the instrument.
//
// The API routes (/api/judge-scenario, /api/judge-legibility) are deliberately
// NOT folded in here: they are HTTP handlers with their own timeouts, error
// shapes and cost reporting. What they share with these is the prompt builders,
// which is where the actual measurement lives.
//
// Imports providers.js and models.js at module scope, and both read process.env
// when they load — so a script must load .env.local BEFORE importing this, the
// same `await import()` discipline scripts/grade-scenario.js already follows.
import { buildJudgePrompt, parseJudgeVerdict } from "./scenario-builder.js";
import { buildBlindLegibilityPrompt, parseBlindLegibility, simulateBlindViews } from "./blind-view.js";
import { callModel } from "./providers.js";
import { costForCall } from "./models.js";

// Pass 1: the five dimensions, with the whole scenario in view.
export async function gradeDimensions({ doc, judge, provider }) {
  const response = await callModel({
    provider,
    model: judge,
    systemPrompt: undefined,
    messages: [{ role: "user", content: buildJudgePrompt(doc) }],
    maxTokens: 1500,
  });
  const cost = costForCall({
    provider,
    model: judge,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
  });
  return { verdict: parseJudgeVerdict(response.text), cost };
}

// Pass 2: per-step legibility, each grader shown ONE step and nothing else.
// Separate from the pass above on purpose — a judge holding the whole scenario
// cannot honestly rate what a context-free executor would notice, and when it
// was asked to, the scores came back inflated by up to two points on every step.
export async function gradeLegibility({ doc, judge, provider }) {
  const views = simulateBlindViews(doc);
  // Concurrent: the steps are independent by construction, and each grader is
  // shown only its own step.
  const steps = await Promise.all(
    views.map(async (view) => {
      const response = await callModel({
        provider,
        model: judge,
        systemPrompt: undefined,
        messages: [{ role: "user", content: buildBlindLegibilityPrompt(view) }],
        maxTokens: 400,
      });
      const cost = costForCall({
        provider,
        model: judge,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
      const parsed = parseBlindLegibility(response.text);
      return {
        step: view.step,
        toolName: view.toolName,
        score: parsed.score,
        rationale: parsed.rationale,
        error: parsed.error,
        cost,
      };
    })
  );
  return { steps, cost: steps.reduce((n, s) => n + s.cost, 0) };
}

// One full grading: both passes, run together. Returns the shape a
// scenario_metrics row stores, plus the raw halves for callers that report on
// them. Both passes at once because they are independent measurements and
// neither needs the other's answer.
export async function gradeOnce({ doc, judge, provider }) {
  const [dims, leg] = await Promise.all([
    gradeDimensions({ doc, judge, provider }),
    gradeLegibility({ doc, judge, provider }),
  ]);
  return {
    dimensions: dims.verdict.scores || {},
    legibility: leg.steps,
    cost: dims.cost + leg.cost,
    dims,
    leg,
  };
}
