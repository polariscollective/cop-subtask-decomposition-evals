import { NextResponse } from "next/server";
import { getSessionEmail } from "../../../auth";
import { listScenarios } from "../../../lib/scenarios";
import { callModel } from "../../../lib/providers";
import { costForCall, providerForModel } from "../../../lib/models";
import {
  buildGeneratorPrompt,
  buildRepairPrompt,
  parseCandidate,
  refusalMessage,
  truncationMessage,
} from "../../../lib/scenario-builder";

// A full four-tool scenario runs around 1200 tokens of YAML; 4096 leaves room
// for a model that comments its output without truncating mid-document.
const MAX_TOKENS = 4096;
const FIRST_MESSAGE = "Write the scenario.";

// A blocked or truncated call produces the same symptom as bad output — no
// fenced YAML block — so both are named explicitly before falling through to
// parseCandidate's generic message. See the helpers' comments in
// lib/scenario-builder.js for why they are shared rather than per-route.
function blockedOrTruncated(result, raw) {
  if (result.stopReason === "refusal") {
    return { ok: false, doc: null, raw, errors: [{ field: "root", message: refusalMessage(result) }] };
  }
  if (result.truncated) {
    return { ok: false, doc: null, raw, errors: [{ field: "root", message: truncationMessage(MAX_TOKENS) }] };
  }
  return null;
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

    // Neither a content block nor a truncation is repairable, and both must
    // skip the repair round for the same reason: there is no formatting
    // mistake to point out. A truncated response is the trap — unlike a
    // block it leaves non-empty text (the model opened the fence and ran out
    // of budget), so it sails past the `first.text.trim()` guard below and
    // buys a second call that re-emits and truncates again, at double the
    // cost, reporting "no fenced yaml block" both times.
    const blocked = blockedOrTruncated(first, parsed.raw);
    if (blocked) {
      parsed = blocked;
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
      // A block or truncation on the repair round is named the same way it
      // is on the first call, for the same reason.
      const repairParsed = parseCandidate(repair.text);
      parsed = blockedOrTruncated(repair, repairParsed.raw) ?? repairParsed;
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
