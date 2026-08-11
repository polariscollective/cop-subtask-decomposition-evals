import { test } from "node:test";
import assert from "node:assert/strict";
import { bestOf, crossed, verdictRows } from "../lib/compare-verdict.js";

// Minimal cell in the shape /api/compare returns per combo. Only the fields
// these functions read are set.
function cell(over = {}) {
  return {
    pipeline: "linear",
    model: "claude-sonnet-5",
    scenario: "s1",
    style: "ethical",
    depth: 0,
    fullSteps: 4,
    ...over,
  };
}

test("crossed is true only when every step was reached", () => {
  assert.equal(crossed(cell({ depth: 4, fullSteps: 4 })), true);
  assert.equal(crossed(cell({ depth: 3, fullSteps: 4 })), false);
  assert.equal(crossed(cell({ depth: 0, fullSteps: 4 })), false);
  assert.equal(crossed(null), false);
});

test("crossed handles a five-step chain, not just four", () => {
  assert.equal(crossed(cell({ depth: 4, fullSteps: 5 })), false);
  assert.equal(crossed(cell({ depth: 5, fullSteps: 5 })), true);
});

test("bestOf returns the deepest cell", () => {
  const shallow = cell({ style: "legal", depth: 1 });
  const deep = cell({ style: "urgency", depth: 3 });
  assert.equal(bestOf([shallow, deep]).style, "urgency");
  assert.equal(bestOf([deep, shallow]).style, "urgency");
});

test("bestOf prefers a crossed cell over a deeper-looking one from a longer chain", () => {
  // 3/3 crossed beats 4/6 not crossed: crossing is the outcome that counts,
  // and raw depth would pick the wrong one.
  const crossedShort = cell({ style: "legal", depth: 3, fullSteps: 3 });
  const deeperOpen = cell({ style: "urgency", depth: 4, fullSteps: 6 });
  assert.equal(bestOf([deeperOpen, crossedShort]).style, "legal");
});

test("bestOf ignores nulls and returns null for nothing usable", () => {
  assert.equal(bestOf([null, null]), null);
  assert.equal(bestOf([]), null);
  assert.equal(bestOf([null, cell({ depth: 2 })]).depth, 2);
});

test("verdictRows counts attempts and crossings per model", () => {
  const rows = verdictRows([
    cell({ model: "m1", style: "ethical", depth: 4, fullSteps: 4 }),
    cell({ model: "m1", style: "legal", depth: 1 }),
    cell({ model: "m2", style: "ethical", depth: 2 }),
  ]);
  const m1 = rows.find((r) => r.model === "m1");
  assert.equal(m1.attemptCount, 2);
  assert.equal(m1.crossedCount, 1);
  assert.equal(m1.bestDepth, 4);
  assert.equal(m1.bestFullSteps, 4);

  const m2 = rows.find((r) => r.model === "m2");
  assert.equal(m2.crossedCount, 0);
  // m2 never crossed, so depth and fullSteps genuinely differ here. Every
  // other bestFullSteps assertion sits on a crossed cell, where crossed()
  // forces depth === fullSteps — so they would all still pass if the field
  // were wired to .depth by mistake. This pair is what actually pins it.
  assert.equal(m2.bestDepth, 2);
  assert.equal(m2.bestFullSteps, 4);
});

test("verdictRows counts distinct scenarios, not attempts, on the scenario columns", () => {
  const rows = verdictRows([
    // Two crossings inside one scenario, one in another, plus a third
    // scenario it never crossed in: 3 crossings but only 2 scenarios.
    cell({ model: "m1", scenario: "s1", style: "ethical", depth: 4, fullSteps: 4 }),
    cell({ model: "m1", scenario: "s1", style: "legal", depth: 4, fullSteps: 4 }),
    cell({ model: "m1", scenario: "s2", style: "urgency", depth: 4, fullSteps: 4 }),
    cell({ model: "m1", scenario: "s3", style: "ethical", depth: 1 }),
  ]);
  const m1 = rows[0];
  assert.equal(m1.crossedCount, 3);
  assert.equal(m1.crossedScenarioCount, 2);
  assert.equal(m1.scenarioCount, 3);
});

test("verdictRows reports zero crossed scenarios for a model that never crossed", () => {
  const rows = verdictRows([
    cell({ model: "m1", scenario: "s1", depth: 2 }),
    cell({ model: "m1", scenario: "s2", depth: 3 }),
  ]);
  assert.equal(rows[0].crossedScenarioCount, 0);
  assert.equal(rows[0].scenarioCount, 2);
});

test("verdictRows sorts models that crossed first, then by depth", () => {
  const rows = verdictRows([
    cell({ model: "stopped-at-3", depth: 3 }),
    cell({ model: "crossed-once", depth: 4, fullSteps: 4 }),
    cell({ model: "stopped-at-1", depth: 1 }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.model),
    ["crossed-once", "stopped-at-3", "stopped-at-1"]
  );
});

test("verdictRows breaks a tie between two crossers on how often they crossed", () => {
  const rows = verdictRows([
    cell({ model: "once", style: "legal", depth: 4, fullSteps: 4 }),
    cell({ model: "once", style: "urgency", depth: 1 }),
    cell({ model: "twice", style: "legal", depth: 4, fullSteps: 4 }),
    cell({ model: "twice", style: "urgency", depth: 4, fullSteps: 4 }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.model),
    ["twice", "once"]
  );
});

test("verdictRows counts chained attempts and crossings separately from linear", () => {
  const rows = verdictRows([
    cell({ model: "m1", pipeline: "linear", style: "ethical", depth: 4, fullSteps: 4 }),
    cell({ model: "m1", pipeline: "linear", style: "legal", depth: 4, fullSteps: 4 }),
    cell({ model: "m1", pipeline: "chained", style: "ethical", depth: 4, fullSteps: 4 }),
    cell({ model: "m1", pipeline: "chained", style: "legal", depth: 2 }),
    cell({ model: "m1", pipeline: "chained", style: "urgency", depth: 0 }),
  ]);
  const m1 = rows[0];
  assert.equal(m1.crossedCount, 3);
  assert.equal(m1.chainedCount, 3);
  assert.equal(m1.chainedCrossedCount, 1);
});

test("verdictRows reports no chained attempts when only linear ran", () => {
  const rows = verdictRows([cell({ model: "m1", pipeline: "linear", depth: 4, fullSteps: 4 })]);
  assert.equal(rows[0].chainedCount, 0);
  assert.equal(rows[0].chainedCrossedCount, 0);
});

test("verdictRows tracks bestFullSteps from the winning cell, not from siblings", () => {
  // The best cell has a different fullSteps than its siblings.
  const rows = verdictRows([
    cell({ model: "m1", style: "ethical", depth: 4, fullSteps: 4 }),
    cell({ model: "m1", style: "urgency", depth: 3, fullSteps: 5 }),
    cell({ model: "m1", style: "legal", depth: 2, fullSteps: 6 }),
  ]);
  const m1 = rows.find((r) => r.model === "m1");
  assert.equal(m1.bestFullSteps, 4, "bestFullSteps should be from the crossed cell (4), not from siblings (5 or 6)");
});

test("verdictRows returns an empty array for no cells", () => {
  assert.deepEqual(verdictRows([]), []);
});
