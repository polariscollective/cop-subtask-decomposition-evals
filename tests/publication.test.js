import { test } from "node:test";
import assert from "node:assert/strict";
import {
  familyIsPublic,
  publicScenarioIds,
  runIsPublic,
  scenarioIsPublic,
} from "../lib/publication.js";

function family(over = {}) {
  return { id: "f1", is_public: true, deleted_at: null, ...over };
}

function scenario(over = {}) {
  return { scenario_id: "s1", family_id: "f1", is_public: true, deleted_at: null, ...over };
}

function run(over = {}) {
  return {
    id: "r1",
    is_public: true,
    scenario_id: "s1",
    ran_against_scenario_id: "s1",
    deleted_at: null,
    data: {},
    ...over,
  };
}

test("a family needs its own flag and a live row", () => {
  assert.equal(familyIsPublic(family()), true);
  assert.equal(familyIsPublic(family({ is_public: false })), false);
  assert.equal(familyIsPublic(family({ deleted_at: "2026-08-11T00:00:00Z" })), false);
  assert.equal(familyIsPublic(null), false);
});

test("a scenario needs its own flag AND its family's", () => {
  assert.equal(scenarioIsPublic(scenario(), family()), true);
  // The case this whole change exists for: a generated candidate landing in a
  // family that is already public must not be published by arriving.
  assert.equal(scenarioIsPublic(scenario({ is_public: false }), family()), false);
  assert.equal(scenarioIsPublic(scenario(), family({ is_public: false })), false);
  // A scenario in no family at all has no family flag to satisfy, so it fails.
  assert.equal(scenarioIsPublic(scenario({ family_id: null }), undefined), false);
});

test("a retired scenario stays published", () => {
  // Trap 1. Every run in the bank ran against a soft-deleted _v0 row; reading
  // retirement as unpublication would take the whole public grid dark.
  assert.equal(scenarioIsPublic(scenario({ deleted_at: "2026-08-11T00:00:00Z" }), family()), true);
});

test("publicScenarioIds keeps only the ones both flags clear", () => {
  const ids = publicScenarioIds(
    [
      scenario({ scenario_id: "live" }),
      scenario({ scenario_id: "retired", deleted_at: "2026-08-11T00:00:00Z" }),
      scenario({ scenario_id: "unpublished", is_public: false }),
      scenario({ scenario_id: "private_family", family_id: "f2" }),
      scenario({ scenario_id: "orphan", family_id: null }),
    ],
    [family(), family({ id: "f2", is_public: false })]
  );
  assert.deepEqual([...ids].sort(), ["live", "retired"]);
});

test("a run needs its own flag on top of both scenarios", () => {
  const ids = new Set(["s1", "s0"]);
  assert.equal(runIsPublic(run(), ids), true);
  assert.equal(runIsPublic(run({ is_public: false }), ids), false);
  assert.equal(runIsPublic(run({ deleted_at: "2026-08-11T00:00:00Z" }), ids), false);
});

test("a run is hidden when the version it ran against is not published", () => {
  // The carried-over case: scenario_id names the live row, ran_against names
  // the superseded one whose text is what the transcript actually shows.
  const ids = new Set(["s1"]);
  assert.equal(runIsPublic(run({ ran_against_scenario_id: "s0" }), ids), false);
  assert.equal(runIsPublic(run({ scenario_id: "s0", ran_against_scenario_id: "s1" }), ids), false);
  assert.equal(runIsPublic(run({ ran_against_scenario_id: "s0" }), new Set(["s1", "s0"])), true);
});

test("a null ran_against stands for the live id, not for 'no scenario'", () => {
  // Rows predating the column carry only data.scenario_id, and a run that never
  // moved has nothing else it could have run against.
  const ids = new Set(["s1"]);
  assert.equal(runIsPublic(run({ ran_against_scenario_id: null }), ids), true);
  assert.equal(
    runIsPublic({ is_public: true, scenario_id: null, ran_against_scenario_id: null, data: { scenario_id: "s1" } }, ids),
    true
  );
});

test("a run whose scenario cannot be resolved fails closed", () => {
  assert.equal(runIsPublic({ is_public: true, data: {} }, new Set(["s1"])), false);
  assert.equal(runIsPublic(null, new Set(["s1"])), false);
});
