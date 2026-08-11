import { NextResponse } from "next/server";
import { getSessionEmail } from "../../../auth";
import { validateScenarioDoc } from "../../../lib/scenarios";
import { callModel } from "../../../lib/providers";
import { costForCall, providerForModel } from "../../../lib/models";
import { buildBlindLegibilityPrompt, parseBlindLegibility, simulateBlindViews } from "../../../lib/blind-view";
import { DEFAULT_GRADING_REPEATS, foldGradings } from "../../../lib/legibility";

// Same reason as the dimension judge: one pass is noisy by about a point, and
// the per-step ceiling sits exactly there.
const MAX_REPEATS = 5;

// One score and one sentence per call — far smaller than the five-dimension
// judge, because each call sees one step and nothing else.
const MAX_TOKENS = 400;

// Scores every step of a scenario for legibility, one model call per step.
//
// Deliberately N calls rather than one: the whole point is that each grader is
// shown ONLY its own step. Batching them into a single prompt would put the
// entire chain back in front of the grader and reproduce exactly the contamination
// this route exists to remove.
export async function POST(req) {
  // Same reasoning as the other generator routes: this spends the org's
  // provider keys and must not rely on middleware alone.
  const userEmail = await getSessionEmail();
  if (!userEmail) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }

  const { ok: docOk } = validateScenarioDoc(body.doc);
  if (!docOk) return NextResponse.json({ error: "doc is not a valid scenario" }, { status: 400 });

  let provider;
  try {
    provider = providerForModel(body.model);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  const views = simulateBlindViews(body.doc);
  const repeat = Math.max(1, Math.min(MAX_REPEATS, Number(body.repeat) || DEFAULT_GRADING_REPEATS));

  try {
    // Concurrent: the steps are independent by construction, and running them
    // in sequence would make grading a four-tool scenario four round-trips deep
    // for no benefit.
    const passResults = await Promise.all(
      Array.from({ length: repeat }, () => gradeOnePass(views, provider, body.model))
    );
    const cost = passResults.reduce((sum, r) => sum + r.cost, 0);

    // Median per step across the passes, matched by step number so a pass that
    // failed on one step does not shift the others.
    const folded = foldGradings(passResults.map((r) => ({ dimensions: {}, legibility: r.steps })));
    const results = folded.legibility;
    const failed = passResults.flatMap((r) => r.steps.filter((x) => x.error));

    return NextResponse.json({
      // A profile with a hole in it is not usable — it hides where in the chain
      // the visibility gap sits, which is the only thing the score is for. The
      // steps that did parse still come back so the failure is diagnosable.
      ok: failed.length === 0 && results.length === views.length,
      steps: results,
      // Every pass's own steps, for the panel that shows what they disagreed
      // about.
      passes: passResults.map((r) => r.steps),
      repeat,
      error: failed.length ? `step(s) ${[...new Set(failed.map((r) => r.step))].join(", ")}: ${failed[0].error}` : null,
      model: body.model,
      provider,
      cost,
    });
  } catch (err) {
    return NextResponse.json({ error: `API call failed: ${err.message || err}`, cost: 0 }, { status: 502 });
  }
}

// One complete sweep of the chain: every step graded from its own blind view.
// Concurrent within a pass — the steps are independent by construction.
async function gradeOnePass(views, provider, model) {
  const steps = await Promise.all(
      views.map(async (view) => {
        const response = await callModel({
          provider,
          model,
          systemPrompt: undefined,
          messages: [{ role: "user", content: buildBlindLegibilityPrompt(view) }],
          maxTokens: MAX_TOKENS,
        });
        const cost = costForCall({
          provider,
          model,
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

  return { steps, cost: steps.reduce((sum, r) => sum + r.cost, 0) };
}
