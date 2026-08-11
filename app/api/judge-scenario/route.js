import { NextResponse } from "next/server";
import { getSessionEmail } from "../../../auth";
import { validateScenarioDoc } from "../../../lib/scenarios";
import { callModel } from "../../../lib/providers";
import { costForCall, providerForModel } from "../../../lib/models";
import { buildJudgePrompt, parseJudgeVerdict, refusalMessage, truncationMessage } from "../../../lib/scenario-builder";
import { DEFAULT_GRADING_REPEATS, foldGradings } from "../../../lib/legibility";

// A single grading moves by about a point, and the floors sit exactly there —
// graded once, a sound scenario can be discarded on one unlucky draw. So the
// verdict is the median of several passes of the same question. Capped at 5:
// beyond that the cost stops buying precision the 1-5 scale can express.
const MAX_REPEATS = 5;

// Five scores and five one-sentence rationales.
const MAX_TOKENS = 1500;

export async function POST(req) {
  // Same reasoning as /api/generate-scenario — this route spends the org's
  // provider keys and must not rely on middleware alone.
  const userEmail = await getSessionEmail();
  if (!userEmail) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  // req.json() resolves successfully for the literal body `null` (and for
  // any non-object JSON value), so the catch above never fires for those —
  // guard here the way app/api/generate-scenario/route.js does, before
  // touching body.doc/body.model.
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }

  // The doc arrives from the client, which got it from /api/generate-scenario
  // — but nothing stops a caller posting anything here, and buildJudgePrompt
  // would happily serialise garbage into a paid model call.
  const { ok: docOk } = validateScenarioDoc(body.doc);
  if (!docOk) return NextResponse.json({ error: "doc is not a valid scenario" }, { status: 400 });

  let provider;
  try {
    provider = providerForModel(body.model);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  const repeat = Math.max(1, Math.min(MAX_REPEATS, Number(body.repeat) || DEFAULT_GRADING_REPEATS));

  try {
    const prompt = buildJudgePrompt(body.doc);
    // Concurrent: the passes are independent by construction — the same
    // question asked again — and running them in sequence would triple the
    // wait for nothing.
    const responses = await Promise.all(
      Array.from({ length: repeat }, () =>
        callModel({
          provider,
          model: body.model,
          systemPrompt: undefined,
          messages: [{ role: "user", content: prompt }],
          maxTokens: MAX_TOKENS,
        })
      )
    );
    const cost = responses.reduce(
      (sum, r) =>
        sum +
        costForCall({
          provider,
          model: body.model,
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
        }),
      0
    );
    // A content block and a truncation both leave parseJudgeVerdict with
    // nothing to find, so both would otherwise surface as the same "no fenced
    // json block" error a badly-formatted judge produces. Naming them matters
    // more here than in the generate route: this endpoint exists to compare
    // judge models, so "refused to grade this content" and "ran out of budget
    // before answering" have to be readable as different verdicts.
    //
    // Truncation is not hypothetical. gemini-pro-latest is a reasoning model
    // and spends this 1500-token budget thinking before it ever emits the
    // JSON block — which read as a formatting failure until this branch
    // existed, and cost that model its place as a usable judge.
    const passes = responses.map((response) => {
      if (response.stopReason === "refusal") return { ok: false, scores: {}, error: refusalMessage(response) };
      if (response.truncated) return { ok: false, scores: {}, error: truncationMessage(MAX_TOKENS) };
      return parseJudgeVerdict(response.text);
    });

    // Only passes that parsed feed the median — a refused or truncated one is
    // a missing measurement, not a low score, and averaging it in as zero
    // would be worse than dropping it.
    const usable = passes.filter((v) => v.ok);
    const folded = foldGradings(usable.map((v) => ({ dimensions: v.scores, legibility: [] })));
    const failed = passes.length - usable.length;

    return NextResponse.json({
      ok: usable.length > 0,
      // The median, in the same {key: {score}} shape a single grading had, so
      // every existing reader keeps working — with min/max/n alongside.
      scores: folded.dimensions,
      // Each pass's own answer, for the panel that shows what they disagreed
      // about. The question was identical every time; only these differ.
      passes: passes.map((v) => ({ ok: v.ok, scores: v.scores, error: v.error })),
      repeat,
      error: usable.length === 0 ? passes[0]?.error || "no pass produced a verdict" : failed ? `${failed} of ${passes.length} passes failed` : null,
      model: body.model,
      provider,
      cost,
    });
  } catch (err) {
    return NextResponse.json({ error: `API call failed: ${err.message || err}`, cost: 0 }, { status: 502 });
  }
}
