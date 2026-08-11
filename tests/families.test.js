import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFamilyView, isRunnable, summarise } from "../lib/families.js";

// A scenario_families row, reduced to the fields buildFamilyView reads.
function family(over = {}) {
  return {
    id: "f1",
    label: "Family one",
    tradeoff: "Legal orders vs concentration of power",
    answer_status: "settled_by_judgement",
    answer_basis: "because",
    description: "a description",
    harness_fit: "fits",
    harness_note: null,
    source: "forethought:3.2",
    is_public: false,
    deleted_at: null,
    ...over,
  };
}

// A scenarios row, likewise.
function scenario(over = {}) {
  return {
    scenario_id: "s1",
    title: "Scenario one",
    family_id: "f1",
    data: { tools: [{}, {}, {}, {}], critical_tool: "migrate" },
    deleted_at: null,
    ...over,
  };
}

test("isRunnable needs BOTH filters to pass", () => {
  assert.equal(isRunnable({ answer_status: "settled_by_law", harness_fit: "fits" }), true);
  assert.equal(isRunnable({ answer_status: "settled_by_judgement", harness_fit: "needs_harness_change" }), true);
  // Fits the harness perfectly, but nothing settles the answer — crossed()
  // would measure nothing, so it is not runnable.
  assert.equal(isRunnable({ answer_status: "contested", harness_fit: "fits" }), false);
  // Clear right answer, wrong shape.
  assert.equal(isRunnable({ answer_status: "settled_by_law", harness_fit: "does_not_fit" }), false);
  assert.equal(isRunnable(null), false);
});

test("signed out sees only published families", () => {
  const view = buildFamilyView({
    families: [family({ id: "pub", is_public: true }), family({ id: "priv", is_public: false })],
    scenarios: [],
    signedIn: false,
  });
  assert.deepEqual(
    view.families.map((f) => f.id),
    ["pub"]
  );
});

test("signed in sees unpublished families too", () => {
  const view = buildFamilyView({
    families: [family({ id: "pub", is_public: true }), family({ id: "priv", is_public: false })],
    scenarios: [],
    signedIn: true,
  });
  assert.equal(view.families.length, 2);
});

test("signed out: source and harness_note never leave the server", () => {
  // Both are internal working commentary — harness_note argues with earlier
  // decisions and can name people, source points at an unpublished draft by
  // section. The badges they explain stay public; the reasoning does not.
  const anon = buildFamilyView({
    families: [family({ is_public: true, source: "forethought:3.2", harness_note: "internal note" })],
    scenarios: [],
    signedIn: false,
  });
  assert.equal("source" in anon.families[0], false);
  assert.equal("harness_note" in anon.families[0], false);

  const signedIn = buildFamilyView({
    families: [family({ source: "forethought:3.2", harness_note: "internal note" })],
    scenarios: [],
    signedIn: true,
  });
  assert.equal(signedIn.families[0].source, "forethought:3.2");
  assert.equal(signedIn.families[0].harness_note, "internal note");
});

test("contested families are gated the same way", () => {
  const anon = buildFamilyView({
    families: [family({ is_public: true, answer_status: "contested", source: "forethought:1c", harness_note: "x" })],
    scenarios: [],
    signedIn: false,
  });
  assert.equal("source" in anon.contested[0], false);
  assert.equal("harness_note" in anon.contested[0], false);
});

test("a soft-deleted family is out for everyone", () => {
  const view = buildFamilyView({
    families: [family({ id: "gone", is_public: true, deleted_at: "2026-08-11T00:00:00Z" })],
    scenarios: [],
    signedIn: true,
  });
  assert.equal(view.families.length, 0);
});

test("signed out: a scenario under an unpublished family is not listed AND not counted", () => {
  // Publication is a property of the family. The count is the part that
  // matters: listing nothing while still counting it would turn scenarioCount
  // into a side channel reporting how much unpublished work exists.
  const view = buildFamilyView({
    families: [family({ id: "pub", is_public: true }), family({ id: "priv", is_public: false })],
    scenarios: [
      scenario({ scenario_id: "shown", family_id: "pub" }),
      scenario({ scenario_id: "hidden", family_id: "priv" }),
    ],
    runCountsByScenario: { shown: 3, hidden: 9 },
    signedIn: false,
  });
  assert.deepEqual(
    view.families.map((f) => f.id),
    ["pub"]
  );
  const [f] = view.families;
  assert.deepEqual(
    f.scenarios.map((s) => s.scenario_id),
    ["shown"]
  );
  assert.equal(f.scenarioCount, 1);
  assert.equal(f.runCount, 3);
  assert.equal(view.totals.scenarioCount, 1);
});

test("signed out: a published family lists its scenarios even with no runs yet", () => {
  // An unbuilt-but-published family and a built one are both part of what the
  // bank says about itself. Gating a scenario row on run activity would hide
  // the bank behind the experiment.
  const view = buildFamilyView({
    families: [family({ id: "f1", is_public: true })],
    scenarios: [scenario({ scenario_id: "fresh", family_id: "f1" })],
    signedIn: false,
  });
  assert.equal(view.families[0].scenarioCount, 1);
  assert.equal(view.families[0].scenarios[0].runCount, 0);
});

test("scenarios with no family_id land in unassigned, not in a family", () => {
  const view = buildFamilyView({
    families: [family({ id: "f1" })],
    scenarios: [scenario({ scenario_id: "a" }), scenario({ scenario_id: "orphan", family_id: null })],
    signedIn: true,
  });
  assert.deepEqual(
    view.families[0].scenarios.map((s) => s.scenario_id),
    ["a"]
  );
  assert.deepEqual(
    view.unassigned.map((s) => s.scenario_id),
    ["orphan"]
  );
  // An orphan is not coverage of anything, so it stays out of the totals.
  assert.equal(view.totals.scenarioCount, 1);
});

test("runnable families sort above unrunnable ones", () => {
  const view = buildFamilyView({
    families: [
      family({ id: "zz_unrunnable", label: "Z", answer_status: "settled_by_judgement", harness_fit: "does_not_fit" }),
      family({ id: "aa_runnable", label: "A", answer_status: "settled_by_judgement", harness_fit: "fits" }),
    ],
    scenarios: [],
    signedIn: true,
  });
  assert.deepEqual(
    view.families.map((f) => f.id),
    ["aa_runnable", "zz_unrunnable"]
  );
});

test("builtCount counts families with a scenario, not scenarios", () => {
  // summarise only ever sees scoreable rows — buildFamilyView splits the
  // contested ones out before calling it — so the totals describe the page.
  const rows = [
    { runnable: true, answer_status: "settled_by_judgement", scenarioCount: 3, runCount: 12 },
    { runnable: true, answer_status: "settled_by_law", scenarioCount: 0, runCount: 0 },
    { runnable: false, answer_status: "settled_by_law", scenarioCount: 0, runCount: 0 },
  ];
  const t = summarise(rows);
  assert.equal(t.familyCount, 3);
  assert.equal(t.runnableCount, 2);
  assert.equal(t.builtCount, 1);
  assert.equal(t.scenarioCount, 3);
  assert.equal(t.runCount, 12);
  assert.deepEqual(
    t.byAnswerStatus.map((s) => [s.key, s.count]),
    [
      ["settled_by_law", 2],
      ["settled_by_judgement", 1],
    ]
  );
});

test("contested families are split out of the listing and out of every total", () => {
  // They stay in the payload as a named count so the page can say the choice
  // was made, but they are not coverage and must not inflate anything.
  const view = buildFamilyView({
    families: [
      family({ id: "scoreable", answer_status: "settled_by_law" }),
      family({ id: "political", label: "Kessler denial", answer_status: "contested" }),
    ],
    scenarios: [scenario({ scenario_id: "a", family_id: "scoreable" })],
    signedIn: true,
  });
  assert.deepEqual(
    view.families.map((f) => f.id),
    ["scoreable"]
  );
  assert.deepEqual(
    view.contested.map((c) => c.label),
    ["Kessler denial"]
  );
  assert.equal(view.totals.familyCount, 1);
});

test("a contested family keeps its scenarios out of the totals too", () => {
  // Otherwise a family we deliberately do not run would still be counted as
  // coverage the moment someone built a scenario under it.
  const view = buildFamilyView({
    families: [family({ id: "political", answer_status: "contested" })],
    scenarios: [scenario({ scenario_id: "a", family_id: "political" })],
    runCountsByScenario: { a: 40 },
    signedIn: true,
  });
  assert.equal(view.totals.scenarioCount, 0);
  assert.equal(view.totals.runCount, 0);
});

test("toolCount is read off the scenario doc, and survives a missing tools array", () => {
  const view = buildFamilyView({
    families: [family()],
    scenarios: [scenario({ scenario_id: "ok" }), scenario({ scenario_id: "bare", data: {} })],
    signedIn: true,
  });
  const byId = Object.fromEntries(view.families[0].scenarios.map((s) => [s.scenario_id, s]));
  assert.equal(byId.ok.toolCount, 4);
  assert.equal(byId.bare.toolCount, null);
});
