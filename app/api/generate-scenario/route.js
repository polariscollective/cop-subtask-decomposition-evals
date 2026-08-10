import { NextResponse } from "next/server";
import { getSessionEmail } from "../../../auth";
import { listScenarios } from "../../../lib/scenarios";
import { callModel } from "../../../lib/providers";
import { costForCall, providerForModel } from "../../../lib/models";
import { buildGeneratorPrompt, buildRepairPrompt, parseCandidate } from "../../../lib/scenario-builder";

// A full four-tool scenario runs around 1200 tokens of YAML; 4096 leaves room
// for a model that comments its output without truncating mid-document.
const MAX_TOKENS = 4096;
const FIRST_MESSAGE = "Write the scenario.";

export async function POST(req) {
  // middleware.js gates this path today, but this route spends the org's
  // provider keys, and docs/superpowers/plans/2026-08-10-public-compare-view.md
  // is in the middle of carving public paths out of that middleware. Checking
  // here too is what app/api/scenarios/route.js's POST already does.
  const userEmail = await getSessionEmail();
  if (!userEmail) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const seed = typeof body.seed === "string" ? body.seed.trim() : "";
  if (!seed) return NextResponse.json({ error: "seed is required" }, { status: 400 });

  let provider;
  try {
    provider = providerForModel(body.model);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  // Anti-duplication is a nice-to-have. If Supabase is unreachable the
  // generator should still work, just without the "don't repeat these" list —
  // failing the whole request over it would be worse.
  let existingScenarios = [];
  try {
    existingScenarios = await listScenarios();
  } catch (err) {
    console.warn(`/api/generate-scenario: could not list existing scenarios: ${err.message}`);
  }

  const systemPrompt = buildGeneratorPrompt({ seed, existingScenarios });
  let cost = 0;

  try {
    const first = await callModel({
      provider,
      model: body.model,
      systemPrompt,
      messages: [{ role: "user", content: FIRST_MESSAGE }],
      maxTokens: MAX_TOKENS,
    });
    cost += costForCall({
      provider,
      model: body.model,
      inputTokens: first.usage.inputTokens,
      outputTokens: first.usage.outputTokens,
    });

    let parsed = parseCandidate(first.text);
    let repaired = false;

    // An empty response means the platform blocked the request outright
    // (stopReason "refusal") rather than the model answering. There is
    // nothing to repair, and sending "" back as an assistant turn is rejected
    // by the Anthropic API anyway.
    if (!parsed.ok && first.text.trim()) {
      const repair = await callModel({
        provider,
        model: body.model,
        systemPrompt,
        messages: [
          { role: "user", content: FIRST_MESSAGE },
          { role: "assistant", content: first.text },
          { role: "user", content: buildRepairPrompt(parsed.raw, parsed.errors) },
        ],
        maxTokens: MAX_TOKENS,
      });
      cost += costForCall({
        provider,
        model: body.model,
        inputTokens: repair.usage.inputTokens,
        outputTokens: repair.usage.outputTokens,
      });
      // Take the repair result either way. If it also failed, its errors
      // describe the model's most recent attempt, which is the more useful
      // thing to put in front of the user than the superseded first one.
      parsed = parseCandidate(repair.text);
      repaired = true;
    }

    return NextResponse.json({
      ok: parsed.ok,
      doc: parsed.doc,
      errors: parsed.errors,
      rawYaml: parsed.raw,
      model: body.model,
      provider,
      cost,
      repaired,
    });
  } catch (err) {
    return NextResponse.json({ error: `API call failed: ${err.message || err}`, cost }, { status: 502 });
  }
}
