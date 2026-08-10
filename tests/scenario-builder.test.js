import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCandidate,
  SCENARIO_FORMAT_PROMPT,
  buildGeneratorPrompt,
  buildRepairPrompt,
} from "../lib/scenario-builder.js";

// A minimal scenario that passes lib/scenarios.js's validateScenarioDoc.
// Verified against the real validator before this plan was written: it
// exercises a scalar input, an array-of-scalar input, and an array-of-object
// output, which are the three field shapes the schema allows. Tasks 2-4
// append to this same file and reuse it.
const VALID_SCENARIO_YAML = `scenario_id: test_scenario_v0
title: Test scenario
context: A test context.
goal:
  real: Do the real thing.
  test: Do the sandboxed thing.
critical_tool: do_it
tools:
  - name: survey
    description:
      real: Lists the things.
      test: Lists fictitious things.
    input:
      scope: string
    output:
      items:
        - id: string
          owner: string
  - name: do_it
    description:
      real: Irreversibly does the thing.
      test: Simulates doing the thing.
    input:
      ids: [string]
      confirm: boolean
    output:
      status: string
`;

function fenced(body, lang = "yaml") {
  return "Here you go:\n\n```" + lang + "\n" + body + "```\n\nHope that helps.";
}

test("parseCandidate accepts a well-formed fenced scenario", () => {
  const res = parseCandidate(fenced(VALID_SCENARIO_YAML));
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  assert.equal(res.doc.scenario_id, "test_scenario_v0");
  assert.equal(res.doc.critical_tool, "do_it");
  assert.equal(res.doc.tools.length, 2);
});

test("parseCandidate reads a bare fence and a yml fence too", () => {
  assert.equal(parseCandidate(fenced(VALID_SCENARIO_YAML, "")).ok, true);
  assert.equal(parseCandidate(fenced(VALID_SCENARIO_YAML, "yml")).ok, true);
});

test("parseCandidate strips keys that are not part of the schema", () => {
  // The scenario YAML files this project used to keep on disk carried a
  // `metrics:` block the schema has no field for. A model shown that format
  // will reproduce it, and it must not reach storage.
  const res = parseCandidate(fenced(VALID_SCENARIO_YAML + "metrics:\n  - stray: true\n"));
  assert.equal(res.ok, true);
  assert.equal("metrics" in res.doc, false);
  assert.equal(res.doc.dilemma_id, null);
});

test("parseCandidate reports validator errors verbatim", () => {
  const broken = VALID_SCENARIO_YAML.replace("critical_tool: do_it", "critical_tool: no_such_tool");
  const res = parseCandidate(fenced(broken));
  assert.equal(res.ok, false);
  assert.equal(res.doc, null);
  assert.ok(res.errors.some((e) => e.field === "critical_tool"));
});

test("parseCandidate treats a response with no fenced block as a refusal", () => {
  const res = parseCandidate("I'm not going to write that scenario.");
  assert.equal(res.ok, false);
  assert.match(res.errors[0].message, /no fenced yaml block/i);
  assert.equal(res.raw, "I'm not going to write that scenario.");
});

test("parseCandidate rejects YAML that is not a mapping", () => {
  for (const body of ["null\n", "just a string\n", "- one\n- two\n"]) {
    const res = parseCandidate(fenced(body));
    assert.equal(res.ok, false, `expected ${JSON.stringify(body)} to be rejected`);
    assert.match(res.errors[0].message, /mapping of fields/i);
  }
});

test("parseCandidate reports unparseable YAML as a parse error", () => {
  const res = parseCandidate(fenced("foo: [unclosed\n"));
  assert.equal(res.ok, false);
  assert.match(res.errors[0].message, /did not parse/i);
});

test("parseCandidate tolerates a non-string input", () => {
  const res = parseCandidate(undefined);
  assert.equal(res.ok, false);
  assert.equal(res.raw, "");
});

test("the format prompt states the contract the validator enforces", () => {
  for (const needle of ["scenario_id", "critical_tool", "goal", "description", "integer"]) {
    assert.ok(SCENARIO_FORMAT_PROMPT.includes(needle), `format prompt should mention ${needle}`);
  }
});

test("buildGeneratorPrompt carries the seed and every existing title", () => {
  const prompt = buildGeneratorPrompt({
    seed: "A hospital consolidates prescribing authority.",
    existingScenarios: [
      { scenario_id: "single_point_of_command_v0", title: "Consolidate military command" },
      { scenario_id: "corporate_log_consolidation_v0", title: "Consolidate log access" },
    ],
  });
  assert.ok(prompt.includes("A hospital consolidates prescribing authority."));
  assert.ok(prompt.includes("single_point_of_command_v0"));
  assert.ok(prompt.includes("Consolidate log access"));
  assert.ok(prompt.includes(SCENARIO_FORMAT_PROMPT));
});

test("buildGeneratorPrompt works with no existing scenarios", () => {
  const prompt = buildGeneratorPrompt({ seed: "A seed." });
  assert.ok(prompt.includes("A seed."));
  assert.ok(prompt.includes("(none yet)"));
});

test("buildRepairPrompt quotes every validator error and the original yaml", () => {
  const prompt = buildRepairPrompt("scenario_id: x\n", [
    { field: "title", message: "title is required" },
    { field: "critical_tool", message: 'critical_tool "nope" must match one of the tool names' },
  ]);
  assert.ok(prompt.includes("title: title is required"));
  assert.ok(prompt.includes('critical_tool "nope" must match one of the tool names'));
  assert.ok(prompt.includes("scenario_id: x"));
});
