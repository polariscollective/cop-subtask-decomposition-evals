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

// stopReason "refusal" means the provider blocked the request server-side,
// before the model meaningfully responded — see the doc comment above
// callModel in lib/providers.js. That's a different failure from the model
// writing malformed YAML, and a caller retrying the same model has no way
// to tell the two apart from errors[].message alone unless we say so here.
// stopDetails is Anthropic-only (OpenAI content_filter and Google
// SAFETY/PROHIBITED_CONTENT are normalised to stopReason "refusal" with no
// stopDetails), so the message must stand on its own without it.
function refusalMessage(result) {
  const parts = ["the provider blocked this request before the model produced a response — this is not a formatting problem"];
  if (result.stopDetails?.category) parts.push(`category: ${result.stopDetails.category}`);
  if (result.stopDetails?.explanation) parts.push(result.stopDetails.explanation);
  return parts.join(" — ");
}

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
  // req.json() resolves successfully for the literal body `null` (and for
  // any non-object JSON value), so the catch above never fires for those —
  // guard here the way app/api/scenarios/route.js's validateScenarioDoc
  // does, before touching body.seed/body.model.
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
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

    // A platform-level content block (stopReason "refusal") means there is
    // nothing to repair — the model never got to respond, so re-sending its
    // (empty) turn back for a repair round would just spend another call to
    // learn nothing. Surface it as its own error instead of falling through
    // to parseCandidate's generic "no fenced yaml block" message, which
    // reads identically to a model that simply wrote bad YAML and gives a
    // caller no signal to stop retrying with this model.
    if (first.stopReason === "refusal") {
      parsed = { ok: false, doc: null, raw: parsed.raw, errors: [{ field: "root", message: refusalMessage(first) }] };
    } else if (!parsed.ok && first.text.trim()) {
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
      // A refusal on the repair round gets the same treatment as one on the
      // first call, for the same reason.
      parsed =
        repair.stopReason === "refusal"
          ? { ok: false, doc: null, raw: parseCandidate(repair.text).raw, errors: [{ field: "root", message: refusalMessage(repair) }] }
          : parseCandidate(repair.text);
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
