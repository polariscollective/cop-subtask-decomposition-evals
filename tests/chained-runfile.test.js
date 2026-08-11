import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChainedRunFileContent } from "../scripts/batch/chained-runfile.js";

const SCENARIO = {
  scenario_id: "s1",
  title: "S1",
  tools: [
    {
      name: "map_nodes",
      description: { real: "Real description.", test: "Sandboxed description." },
      input: { scope: "string" },
      output: { nodes: ["string"] },
    },
  ],
};

function build(model) {
  return buildChainedRunFileContent({
    batchId: "b1",
    scenario: SCENARIO,
    attempt: { model, style: "ethical" },
    result: { toolsCalled: ["a"], totalTools: 4, turns: [], messages: [], cost: 0.1 },
    systemPrompt: "sys",
    initialUserMessage: "go",
  });
}

// The dashboard repopulates its provider selector from this field when a
// saved run is loaded (app/dashboard/page.js), and sends it back with the
// model on "Continue arguing" — so a hardcoded provider here sends a
// non-Anthropic model id straight to Anthropic's API.
test("buildChainedRunFileContent records the model's real provider", () => {
  assert.equal(build("grok-4.5").direct_result.provider, "xai");
  assert.equal(build("gpt-4o").direct_result.provider, "openai");
  assert.equal(build("gemini-3.6-flash").direct_result.provider, "google");
  assert.equal(build("claude-haiku-4-5").direct_result.provider, "anthropic");
});

// The tool descriptions never appear in any message — they travel in the
// API's own `tools` field — so without recording them here there is no way
// to audit from a saved run what the model was actually shown, only to
// re-derive it from the code that produced it.
test("buildChainedRunFileContent records the tool schemas the model was sent", () => {
  assert.deepEqual(build("grok-4.5").direct_result.tools, [
    {
      name: "map_nodes",
      description: "Real description.",
      input_schema: { type: "object", properties: { scope: { type: "string" } }, required: ["scope"] },
    },
  ]);
});

// Chained runs are always asked under the real framing — the test pretext
// exists only in the plan pipeline — so the recorded description must be
// the real one, never the sandboxed wording.
test("buildChainedRunFileContent records the real description, not the test one", () => {
  assert.equal(build("grok-4.5").direct_result.tools[0].description, "Real description.");
});

test("buildChainedRunFileContent keeps the system prompt it was given", () => {
  assert.equal(build("grok-4.5").direct_result.system_prompt, "sys");
});
