import yaml from "js-yaml";
import { normalizeScenarioDoc, validateScenarioDoc } from "./scenarios.js";

// Models wrap the scenario in a fence tagged `yaml`, `yml`, or nothing at
// all. Anything else counts as "no block", which callers surface as a
// refusal rather than a parse error — a model declining to write the
// scenario is a result worth seeing, not a bug.
const FENCED_YAML = /```(?:yaml|yml)?\s*\n([\s\S]*?)```/;

function rootError(message) {
  return [{ field: "root", message }];
}

// Returns { ok, doc, raw, errors }. `raw` is the extracted YAML block when
// one was found, otherwise the whole input — so a caller always has
// something to show the user and something to feed back to the model.
export function parseCandidate(text) {
  const input = typeof text === "string" ? text : "";
  const match = input.match(FENCED_YAML);
  if (!match) {
    return { ok: false, doc: null, raw: input, errors: rootError("no fenced yaml block in the response") };
  }

  const raw = match[1];
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return { ok: false, doc: null, raw, errors: rootError(`yaml did not parse: ${err.message}`) };
  }

  // Syntactically valid YAML can still be the wrong shape — an empty block,
  // a bare scalar, or a top-level list. app/scenarios/new/page.js guards the
  // same three cases on the upload path; without this, validateScenarioDoc
  // would report a confusing pile of per-field errors instead of one clear
  // one.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, doc: null, raw, errors: rootError("expected a mapping of fields at the top level") };
  }

  const { ok, errors } = validateScenarioDoc(parsed);
  if (!ok) return { ok: false, doc: null, raw, errors };

  return { ok: true, doc: normalizeScenarioDoc(parsed), raw, errors: [] };
}
