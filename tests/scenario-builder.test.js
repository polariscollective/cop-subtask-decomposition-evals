import { test } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";
import {
  parseCandidate,
  SCENARIO_FORMAT_PROMPT,
  buildGeneratorPrompt,
  buildRepairPrompt,
  buildJudgePrompt,
  parseJudgeVerdict,
} from "../lib/scenario-builder.js";
import { validateScenarioDoc } from "../lib/scenarios.js";
import { JUDGE_DIMENSIONS } from "../lib/judge-dimensions.js";
import { SEED_PRESETS } from "../lib/seed-presets.js";

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

function yamlDoc(text) {
  return yaml.load(text);
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

const DOC = parseCandidate("```yaml\n" + VALID_SCENARIO_YAML + "```").doc;

function verdict(overrides = {}) {
  const body = {};
  for (const d of JUDGE_DIMENSIONS) body[d.key] = { score: 4, rationale: "fine" };
  return "```json\n" + JSON.stringify({ ...body, ...overrides }) + "\n```";
}

test("the five dimensions are the ones the spec settled on", () => {
  assert.deepEqual(
    JUDGE_DIMENSIONS.map((d) => d.key),
    ["causal_chaining", "critical_step_is_critical", "pretense_is_plausible", "harm_is_real", "compliance_is_tempting"]
  );
  for (const d of JUDGE_DIMENSIONS) {
    assert.ok(d.label.length > 0, `${d.key} needs a label`);
    assert.ok(d.question.length > 0, `${d.key} needs a question`);
  }
});

test("buildJudgePrompt embeds the doc as yaml and asks for every dimension", () => {
  const prompt = buildJudgePrompt(DOC);
  assert.ok(prompt.includes("test_scenario_v0"));
  assert.ok(prompt.includes("Irreversibly does the thing."));
  for (const d of JUDGE_DIMENSIONS) assert.ok(prompt.includes(d.key), `prompt should ask for ${d.key}`);
});

test("parseJudgeVerdict reads a complete verdict", () => {
  const res = parseJudgeVerdict(verdict());
  assert.equal(res.ok, true);
  assert.equal(res.error, null);
  assert.equal(Object.keys(res.scores).length, 5);
  assert.equal(res.scores.harm_is_real.score, 4);
  assert.equal(res.scores.harm_is_real.rationale, "fine");
});

test("parseJudgeVerdict reports a missing dimension but keeps the rest", () => {
  const body = JSON.parse(verdict().replace(/```json\n|\n```/g, ""));
  delete body.pretense_is_plausible;
  const res = parseJudgeVerdict("```json\n" + JSON.stringify(body) + "\n```");
  assert.equal(res.ok, false);
  assert.match(res.error, /pretense_is_plausible/);
  assert.equal(Object.keys(res.scores).length, 4);
});

test("parseJudgeVerdict rejects out-of-range and non-numeric scores", () => {
  assert.equal(parseJudgeVerdict(verdict({ harm_is_real: { score: 9, rationale: "x" } })).ok, false);
  assert.equal(parseJudgeVerdict(verdict({ harm_is_real: { score: 0, rationale: "x" } })).ok, false);
  assert.equal(parseJudgeVerdict(verdict({ harm_is_real: { score: "high", rationale: "x" } })).ok, false);
});

test("parseJudgeVerdict handles a judge that answered in prose", () => {
  const res = parseJudgeVerdict("I'd rather not grade this.");
  assert.equal(res.ok, false);
  assert.match(res.error, /no fenced json block/i);
  assert.deepEqual(res.scores, {});
});

test("parseJudgeVerdict handles unparseable json", () => {
  const res = parseJudgeVerdict("```json\n{not json}\n```");
  assert.equal(res.ok, false);
  assert.match(res.error, /did not parse/i);
});

test("every preset has a unique id, a label and a non-trivial seed", () => {
  assert.ok(SEED_PRESETS.length >= 6);
  const ids = new Set();
  for (const p of SEED_PRESETS) {
    assert.ok(!ids.has(p.id), `duplicate preset id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.label.length > 0, `${p.id} needs a label`);
    assert.ok(p.text.trim().length > 200, `${p.id}'s seed is too short to steer a generator`);
  }
});

test("no preset carries the sibling project's no-obvious-answer clause", () => {
  // model-specs-evals measures self-consistency on a genuine dilemma and its
  // seeds say "must NOT have an obvious correct answer". This project has a
  // right answer, so importing that clause would steer the generator away
  // from exactly the scenarios it should produce.
  for (const p of SEED_PRESETS) {
    assert.doesNotMatch(p.text, /obvious correct answer/i, `${p.id} still carries the inverted clause`);
    assert.doesNotMatch(p.text, /defend either/i, `${p.id} still carries the inverted clause`);
  }
});

test("validateScenarioDoc requires the critical tool to be the last one", () => {
  // The page reads "reached every step" as "made the irreversible call",
  // which only holds if the critical tool is last in the chain.
  const doc = yamlDoc(VALID_SCENARIO_YAML);
  doc.critical_tool = "survey"; // the first of the two tools
  const res = validateScenarioDoc(doc);
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.field === "critical_tool" && /last/i.test(e.message)),
    `expected a critical_tool "last" error, got ${JSON.stringify(res.errors)}`
  );
});

test("validateScenarioDoc still accepts a doc whose critical tool is last", () => {
  assert.deepEqual(validateScenarioDoc(yamlDoc(VALID_SCENARIO_YAML)), { ok: true });
});
