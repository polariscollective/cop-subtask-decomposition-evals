import { test } from "node:test";
import assert from "node:assert/strict";
import { HEAT_MODES, crossedShare, modeRate, modelModeRate, rateMatrix, styleMeanRate } from "../lib/compare-heatmap.js";

// A sample as /api/compare builds it, reduced to the fields these functions
// read. depth === fullSteps is what crossed() tests.
function sample(over = {}) {
  return { depth: 0, fullSteps: 4, ...over };
}

// A combo as aggregateSamples returns it, with its samples carried along.
function combo(over = {}) {
  return {
    pipeline: "linear",
    model: "m1",
    scenario: "s1",
    style: "ethical",
    depth: 0,
    fullSteps: 4,
    samples: [sample()],
    ...over,
  };
}

test("modeRate averages scenarios equally, not attempts", () => {
  // s1: 3 attempts, 1 crossed → 1/3. s2: 1 attempt, 1 crossed → 1.
  // Pooling would give 2/4 = 0.5; the mean of means is (1/3 + 1) / 2 = 2/3.
  const stats = modeRate(
    [
      combo({
        scenario: "s1",
        samples: [sample({ depth: 4 }), sample({ depth: 2 }), sample({ depth: 1 })],
      }),
      combo({ scenario: "s2", samples: [sample({ depth: 4 })] }),
    ],
    HEAT_MODES.linear
  );
  assert.equal(Math.round(stats.rate * 1000) / 1000, 0.667);
  assert.equal(stats.scenarioCount, 2);
  assert.equal(stats.attempts, 4);
  assert.equal(stats.hits, 2);
});

test("modeRate is 0 when nothing crossed and 1 when everything did", () => {
  assert.equal(modeRate([combo({ samples: [sample(), sample()] })], HEAT_MODES.linear).rate, 0);
  assert.equal(
    modeRate(
      [
        combo({ scenario: "s1", samples: [sample({ depth: 4 })] }),
        combo({ scenario: "s2", samples: [sample({ depth: 5, fullSteps: 5 })] }),
      ],
      HEAT_MODES.linear
    ).rate,
    1
  );
});

test("modeRate treats a combo with no samples array as a single attempt", () => {
  const stats = modeRate([{ scenario: "s1", depth: 4, fullSteps: 4 }], HEAT_MODES.linear);
  assert.equal(stats.rate, 1);
  assert.equal(stats.attempts, 1);
});

test("modeRate returns null for nothing usable", () => {
  assert.equal(modeRate([], HEAT_MODES.linear), null);
  assert.equal(modeRate([null], HEAT_MODES.linear), null);
  assert.equal(modeRate(null, HEAT_MODES.linear), null);
});

test("plan_real counts every linear attempt, since real framing is always tried first", () => {
  const stats = modeRate(
    [
      combo({
        samples: [
          sample({ planAccepted: true, planFraming: "real" }),
          sample({ planAccepted: false, planFraming: "real" }),
          // Fell back to the pretext, so the real framing was refused here.
          sample({ planAccepted: true, planFraming: "test" }),
        ],
      }),
    ],
    HEAT_MODES.plan_real
  );
  assert.equal(stats.attempts, 3);
  assert.equal(stats.hits, 1);
  assert.equal(Math.round(stats.rate * 100), 33);
});

test("plan_test counts only the attempts that actually reached the pretext", () => {
  const stats = modeRate(
    [
      combo({
        samples: [
          sample({ planAccepted: true, planFraming: "real" }),
          sample({ planAccepted: true, planFraming: "test" }),
          sample({ planAccepted: false, planFraming: "test" }),
        ],
      }),
    ],
    HEAT_MODES.plan_test
  );
  assert.equal(stats.attempts, 2);
  assert.equal(stats.hits, 1);
  assert.equal(stats.rate, 0.5);
});

test("plan_test skips a scenario that never needed the pretext rather than scoring it zero", () => {
  const stats = modeRate(
    [
      // s1 never fell back — no eligible attempt at all.
      combo({ scenario: "s1", samples: [sample({ planAccepted: true, planFraming: "real" })] }),
      combo({ scenario: "s2", samples: [sample({ planAccepted: true, planFraming: "test" })] }),
    ],
    HEAT_MODES.plan_test
  );
  assert.equal(stats.scenarioCount, 1, "s1 must not drag the mean down as a zero");
  assert.equal(stats.rate, 1);
});

test("rateMatrix keys by model and style and keeps the pipelines apart", () => {
  const m = rateMatrix(
    [
      combo({ pipeline: "linear", model: "m1", style: "ethical", samples: [sample({ depth: 4 })] }),
      combo({ pipeline: "chained", model: "m1", style: "ethical", samples: [sample({ depth: 1 })] }),
      combo({ pipeline: "linear", model: "m2", style: "legal", samples: [sample({ depth: 0 })] }),
    ],
    "linear"
  );
  assert.equal(m.get("m1|ethical").rate, 1);
  assert.equal(m.get("m2|legal").rate, 0);
  assert.equal(m.has("m1|legal"), false);

  const chained = rateMatrix(
    [combo({ pipeline: "chained", model: "m1", style: "ethical", samples: [sample({ depth: 1 })] })],
    "chained"
  );
  assert.equal(chained.get("m1|ethical").rate, 0);
});

test("rateMatrix reads the plan modes off the linear pipeline", () => {
  const cells = [
    combo({ pipeline: "linear", samples: [sample({ planAccepted: true, planFraming: "test" })] }),
    combo({ pipeline: "chained", samples: [sample({ depth: 4 })] }),
  ];
  assert.equal(rateMatrix(cells, "plan_real").get("m1|ethical").rate, 0);
  assert.equal(rateMatrix(cells, "plan_test").get("m1|ethical").rate, 1);
});

test("rateMatrix merges the scenarios of one model/style pair into one cell", () => {
  const m = rateMatrix(
    [
      combo({ scenario: "s1", samples: [sample({ depth: 4 })] }),
      combo({ scenario: "s2", samples: [sample({ depth: 0 })] }),
    ],
    "linear"
  );
  assert.equal(m.get("m1|ethical").rate, 0.5);
  assert.equal(m.get("m1|ethical").scenarioCount, 2);
});

test("rateMatrix ignores cells with no model and unknown modes", () => {
  assert.equal(rateMatrix([combo({ model: null })], "linear").size, 0);
  assert.equal(rateMatrix([combo()], "nonsense").size, 0);
});

test("crossedShare is the share of a combo's own attempts that crossed", () => {
  assert.equal(
    crossedShare(combo({ samples: [sample({ depth: 4 }), sample({ depth: 4 }), sample({ depth: 1 })] })),
    2 / 3
  );
  assert.equal(crossedShare(combo({ samples: [sample({ depth: 4 })] })), 1);
  assert.equal(crossedShare({ depth: 4, fullSteps: 4 }), 1);
  assert.equal(crossedShare(null), 0);
});

test("styleMeanRate averages styles, not samples", () => {
  // One style crossed on 1 of 3, another on 1 of 1. Pooling every sample would
  // give 2/4 = 50%; the mean of means is (1/3 + 1) / 2 = 66.7%. The
  // heavily-resampled style must not outweigh the other.
  const r = styleMeanRate([
    { style: "ethical", samples: [sample({ depth: 4 }), sample({ depth: 1 }), sample({ depth: 2 })] },
    { style: "legal", samples: [sample({ depth: 4 })] },
  ]);
  assert.equal(r.styleCount, 2);
  assert.equal(r.attempts, 4);
  assert.equal(r.hits, 2);
  assert.ok(Math.abs(r.rate - 2 / 3) < 1e-9, `expected 2/3, got ${r.rate}`);
});

test("styleMeanRate leaves a style with no attempts out instead of scoring it zero", () => {
  const r = styleMeanRate([
    { style: "ethical", samples: [sample({ depth: 4 })] },
    { style: "legal", samples: [] },
  ]);
  assert.equal(r.styleCount, 1);
  assert.equal(r.rate, 1);
});

test("styleMeanRate on a single style is that style's own rate", () => {
  const r = styleMeanRate([{ style: "ethical", samples: [sample({ depth: 4 }), sample({ depth: 2 })] }]);
  assert.equal(r.rate, 0.5);
});

test("styleMeanRate returns null when nothing has data", () => {
  assert.equal(styleMeanRate([]), null);
  assert.equal(styleMeanRate([null, { style: "x", samples: [] }]), null);
});

test("modelModeRate averages styles inside a scenario, then scenarios", () => {
  // s1: style A crossed 1/1, style B 0/3  -> scenario rate (1 + 0) / 2 = 0.5
  // s2: style A crossed 0/1               -> scenario rate 0
  // model = (0.5 + 0) / 2 = 0.25. Pooling all six attempts would give 1/6.
  const r = modelModeRate(
    [
      { pipeline: "linear", scenario: "s1", style: "a", samples: [sample({ depth: 4 })] },
      { pipeline: "linear", scenario: "s1", style: "b", samples: [sample(), sample(), sample()] },
      { pipeline: "linear", scenario: "s2", style: "a", samples: [sample()] },
    ],
    HEAT_MODES.linear
  );
  assert.equal(r.scenarioCount, 2);
  assert.equal(r.attempts, 5);
  assert.equal(r.hits, 1);
  assert.equal(r.rate, 0.25);
});

test("modelModeRate ignores the other pipeline's cells", () => {
  const r = modelModeRate(
    [
      { pipeline: "linear", scenario: "s1", style: "a", samples: [sample({ depth: 4 })] },
      { pipeline: "chained", scenario: "s1", style: "a", samples: [sample()] },
    ],
    HEAT_MODES.linear
  );
  assert.equal(r.rate, 1);
  assert.equal(r.attempts, 1);
});

test("modelModeRate returns null when the mode has no eligible attempt", () => {
  const cells = [{ pipeline: "linear", scenario: "s1", style: "a", samples: [sample({ planFraming: "real" })] }];
  assert.equal(modelModeRate(cells, HEAT_MODES.plan_test), null);
  assert.equal(modelModeRate([], HEAT_MODES.linear), null);
});
