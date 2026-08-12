// Pure derivation for the families page. Same import discipline as
// lib/compare-heatmap.js and lib/compare-verdict.js: imports nothing beyond
// lib/publication.js, which is itself import-free, so the client component can
// use it without pulling anything server-side into the browser bundle.
//
// A "family" is one HARD CASE, deliberately not "one dilemma". A dilemma has
// two defensible sides; these do not. Every family here has a right answer —
// don't cross the critical step — and what makes it hard is that reaching that
// answer is expensive: the authorisation is genuine, the benefit is real, and
// refusing costs something. Calling it a dilemma imports exactly the framing
// this project rejects, and which lib/judge-dimensions.js explains dropping.
//
// Scenarios are dressings of a family — same tradeoff, different institution
// and vocabulary — so the two existing scenarios (military and corporate) are
// one family, not two. That distinction is the whole reason this page exists:
// the grid shows scenarios, and reading it without knowing which of them share
// a hard case overstates how much of the space has been covered.

import { scenarioIsPublic } from "./publication.js";

// What makes the wrong answer wrong. NOT a confidence scale: the first two
// both have a real right answer — don't cross — and differ only in what you
// cite when someone challenges the score. Calling the second one "defensible"
// read as "arguable", which is the opposite of what it means.
export const ANSWER_STATUS = {
  settled_by_law: {
    key: "settled_by_law",
    label: "Settled by law",
    tone: "ok",
    scoreable: true,
    blurb:
      "A statute or written rule decides. Crossing is wrong, and if anyone disputes the score you cite the text.",
  },
  settled_by_judgement: {
    key: "settled_by_judgement",
    label: "Settled by judgement",
    tone: "ok",
    scoreable: true,
    blurb:
      "There is still a right answer — don't cross — but what makes it wrong is the consequence: an irreversible loss of a control point. No text settles it, so the reasoning is stated on each family instead. Scored exactly like the ones above.",
  },
  contested: {
    key: "contested",
    label: "Genuinely contested",
    tone: "neutral",
    scoreable: false,
    blurb:
      "No agreed answer. Forethought poses these as political questions and declines to adjudicate them, so counting a crossing would measure nothing. Recorded so the choice not to run them is visible, and kept off this page.",
  },
};

// Whether the four-tool chain can carry it. Independent of the above — a
// family can have a rock-solid right answer and still be unbuildable, and vice
// versa.
export const HARNESS_FIT = {
  fits: {
    key: "fits",
    label: "Ready to build",
    tone: "ok",
    blurb:
      "Four tools, every one feeding the critical last step — as a chain, as an aggregator, or a mix. Ends on an unconditional, irreversible step. Nothing has to change first.",
  },
  needs_harness_change: {
    key: "needs_harness_change",
    label: "Needs a harness change",
    tone: "warn",
    blurb:
      "The scenario is sound; a harness rule has to give before it can be built. Which rule is named on the family itself.",
  },
  does_not_fit: {
    key: "does_not_fit",
    label: "Out of scope",
    tone: "neutral",
    blurb: "A single decision or a conversational stance, with no build-up to decompose.",
  },
};

// The sections the page renders, in order. `contested` is deliberately absent:
// it stays in Supabase as a record of what was considered and set aside, but
// putting it on a page about what we measure invites reading it as coverage.
export const ANSWER_STATUS_ORDER = ["settled_by_law", "settled_by_judgement"];

export function isScoreable(family) {
  return Boolean(family && ANSWER_STATUS[family.answer_status]?.scoreable);
}

export function answerStatusMeta(key) {
  return ANSWER_STATUS[key] || null;
}

export function harnessFitMeta(key) {
  return HARNESS_FIT[key] || null;
}

// A family is runnable when BOTH filters pass. Kept as one function rather
// than inlined at each call site so the page, the counts and any future batch
// selection cannot drift on what "runnable" means.
export function isRunnable(family) {
  if (!family) return false;
  return (
    isScoreable(family) &&
    (family.harness_fit === "fits" || family.harness_fit === "needs_harness_change")
  );
}

// Builds the whole page payload.
//
// Publication is a conjunction: a scenario is listed to an anonymous visitor
// only when its own is_public is set AND its family's is (lib/publication.js).
// The family half is what makes an unbuilt-but-published family and a built one
// both part of what the bank says about itself — publication is never gated on
// run activity, so a published scenario nobody has run yet is still listed. The
// scenario half is what stops a newly created row, in particular a generated
// candidate, from being published by the mere fact of landing in a family that
// already is.
//
// `runCountsByScenario` is pre-filtered by the caller: for an anonymous
// visitor it counts published runs only, so the number on the page always
// matches the dataset that visitor can actually open. A scenario with no
// published runs is still listed — it just reads "0 runs".
export function buildFamilyView({
  families = [],
  scenarios = [],
  runCountsByScenario = {},
  signedIn = false,
} = {}) {
  const visibleFamilies = families.filter((f) => {
    if (!f || f.deleted_at) return false;
    return signedIn || f.is_public;
  });

  // A scenario is listed under its family when both are published. It is
  // filtered here rather than at the two call sites below so that a hidden
  // scenario is not merely absent from the expanded list, it is not counted
  // either — or the count becomes a side channel reporting how much
  // unpublished work exists, which is the same leak whether what is withheld
  // is a whole family or one dressing of it.
  const familyById = new Map();
  for (const f of families || []) {
    if (f?.id) familyById.set(f.id, f);
  }
  const canSeeScenario = (s) => {
    if (!s || s.deleted_at) return false;
    if (signedIn) return true;
    return scenarioIsPublic(s, familyById.get(s.family_id));
  };

  const byFamily = new Map();
  const unassigned = [];
  for (const s of scenarios) {
    if (!canSeeScenario(s)) continue;
    const entry = {
      scenario_id: s.scenario_id,
      title: s.title,
      toolCount: Array.isArray(s.data?.tools) ? s.data.tools.length : null,
      criticalTool: s.data?.critical_tool ?? null,
      runCount: runCountsByScenario[s.scenario_id] || 0,
    };
    if (!s.family_id) {
      unassigned.push(entry);
      continue;
    }
    if (!byFamily.has(s.family_id)) byFamily.set(s.family_id, []);
    byFamily.get(s.family_id).push(entry);
  }

  const toRow = (f) => {
    const built = (byFamily.get(f.id) || []).sort((a, b) => a.title.localeCompare(b.title));
    return {
      id: f.id,
      label: f.label,
      tradeoff: f.tradeoff,
      answer_status: f.answer_status,
      answer_basis: f.answer_basis,
      description: f.description,
      harness_fit: f.harness_fit,
      // Internal, signed-in only. `harness_note` is working commentary — it
      // argues with earlier decisions, names people, and quotes an unpublished
      // draft. `source` points at that draft by section number, which discloses
      // both that we are working from it and where in it we are. The badge they
      // qualify stays public; the reasoning behind it does not.
      ...(signedIn ? { harness_note: f.harness_note, source: f.source } : {}),
      runnable: isRunnable(f),
      scenarios: built,
      scenarioCount: built.length,
      runCount: built.reduce((n, s) => n + s.runCount, 0),
    };
  };

  // FUTURE WORK — contested families are separated here and nowhere else. They
  // are still listed, at the bottom of the page and clearly set aside, because
  // recording what was considered and parked is more useful than hiding it. What
  // they must never do is enter `totals`: a family we have decided not to run is
  // not coverage, and counting it would flatter the numbers. Deleting this split
  // is the whole change needed to bring them back into the main listing.
  const contested = visibleFamilies
    .filter((f) => !isScoreable(f))
    .map(toRow)
    .sort((a, b) => a.label.localeCompare(b.label));

  const rows = visibleFamilies.filter(isScoreable).map(toRow);

  // Runnable first, then families that have something built, then alphabetical
  // — so the part of the page that can actually be acted on is at the top of
  // each section rather than scattered through it.
  rows.sort(
    (a, b) =>
      Number(b.runnable) - Number(a.runnable) ||
      b.scenarioCount - a.scenarioCount ||
      a.label.localeCompare(b.label)
  );

  return {
    families: rows,
    contested,
    unassigned: unassigned.sort((a, b) => a.title.localeCompare(b.title)),
    totals: summarise(rows),
  };
}

// Headline counts, over the scoreable families only — the ones the page shows.
// `builtCount` is families with at least one scenario, which is the number that
// matters: a family nobody has built is a plan, not coverage.
export function summarise(rows = []) {
  return {
    familyCount: rows.length,
    runnableCount: rows.filter((r) => r.runnable).length,
    builtCount: rows.filter((r) => r.scenarioCount > 0).length,
    scenarioCount: rows.reduce((n, r) => n + r.scenarioCount, 0),
    runCount: rows.reduce((n, r) => n + r.runCount, 0),
    byAnswerStatus: ANSWER_STATUS_ORDER.map((key) => ({
      key,
      count: rows.filter((r) => r.answer_status === key).length,
    })),
  };
}
