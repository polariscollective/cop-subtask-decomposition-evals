import { NextResponse } from "next/server";
import { getSessionEmail } from "../../../auth";
import { validateScenarioDoc } from "../../../lib/scenarios";
import { callModel } from "../../../lib/providers";
import { costForCall, providerForModel } from "../../../lib/models";
import { buildJudgePrompt, parseJudgeVerdict } from "../../../lib/scenario-builder";

// Five scores and five one-sentence rationales.
const MAX_TOKENS = 1500;

// stopReason "refusal" means the provider blocked the request server-side,
// before the model meaningfully responded — see the doc comment above
// callModel in lib/providers.js. That's a different failure from the model
// writing malformed JSON, and here it matters even more than it does for
// /api/generate-scenario: this endpoint grades scenarios about removing
// human oversight, plausible refusal-trigger content, and the whole point
// of the feature is comparing judge models against each other. A model
// that won't grade the content must look different from one that can't
// format its answer. stopDetails is Anthropic-only (OpenAI content_filter
// and Google SAFETY/PROHIBITED_CONTENT are normalised to stopReason
// "refusal" with no stopDetails), so the message must stand on its own
// without it.
function refusalMessage(result) {
  const parts = ["the provider blocked this request before the model produced a response — this is not a formatting problem"];
  if (result.stopDetails?.category) parts.push(`category: ${result.stopDetails.category}`);
  if (result.stopDetails?.explanation) parts.push(result.stopDetails.explanation);
  return parts.join(" — ");
}

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

  try {
    const response = await callModel({
      provider,
      model: body.model,
      systemPrompt: undefined,
      messages: [{ role: "user", content: buildJudgePrompt(body.doc) }],
      maxTokens: MAX_TOKENS,
    });
    const cost = costForCall({
      provider,
      model: body.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });
    // A platform-level content block (stopReason "refusal") means there is
    // nothing to parse — response.text is empty, and parseJudgeVerdict("")
    // would return the same "no fenced json block" error a badly-formatted
    // judge model produces. Surface it as its own error instead so a caller
    // comparing judge models can tell "refused to grade" from "couldn't
    // format its answer".
    const verdict =
      response.stopReason === "refusal"
        ? { ok: false, scores: {}, error: refusalMessage(response) }
        : parseJudgeVerdict(response.text);

    return NextResponse.json({
      ok: verdict.ok,
      scores: verdict.scores,
      error: verdict.error,
      model: body.model,
      provider,
      cost,
    });
  } catch (err) {
    return NextResponse.json({ error: `API call failed: ${err.message || err}`, cost: 0 }, { status: 502 });
  }
}
