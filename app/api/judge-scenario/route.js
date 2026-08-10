import { NextResponse } from "next/server";
import { getSessionEmail } from "../../../auth";
import { validateScenarioDoc } from "../../../lib/scenarios";
import { callModel } from "../../../lib/providers";
import { costForCall, providerForModel } from "../../../lib/models";
import { buildJudgePrompt, parseJudgeVerdict } from "../../../lib/scenario-builder";

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
    const verdict = parseJudgeVerdict(response.text);

    return NextResponse.json({
      ok: verdict.ok,
      scores: verdict.scores,
      error: verdict.error,
      model: body.model,
      provider,
      cost,
    });
  } catch (err) {
    return NextResponse.json({ error: `API call failed: ${err.message || err}` }, { status: 502 });
  }
}
