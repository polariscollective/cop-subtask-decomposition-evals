// What an anonymous reader may see, in one place.
//
// Publication is a CONJUNCTION that descends. Each level needs its own flag and
// every flag above it:
//
//   family visible    <=>  family.is_public
//   scenario visible  <=>  scenario.is_public  AND  family visible
//   run visible       <=>  run.is_public       AND  both of its scenarios visible
//
// "Both of its scenarios" is scenario_id and ran_against_scenario_id. After a
// revision carries runs over those are two different rows, and the transcript
// discloses the text of the one it actually executed against — so a run is
// published under both names or under neither.
//
// This module exists because three read paths used to derive "visible"
// independently and had drifted into three different rules: /api/families
// inherited from the family, /api/scenario-detail ALSO unlocked a spec from
// below whenever a published run pointed at it, and /api/compare consulted
// neither. The upward unlock is now gone; under the conjunction a run cannot be
// public unless its scenario already is, so it could never have fired again.
//
// These predicates answer "is this published", never "may this caller see it".
// Call sites keep their own `signedIn ||` in front, so a session bypasses
// publication exactly as it does today.
//
// Imports nothing, same discipline as lib/families.js and lib/compare-heatmap.js
// — the families page is a client component and pulls this in through
// buildFamilyView.

export function familyIsPublic(family) {
  return Boolean(family && family.is_public && !family.deleted_at);
}

// deleted_at is deliberately NOT consulted on the scenario. A retired row is
// the definition an older run actually saw, and every run in the bank points at
// one through ran_against_scenario_id — reading "retired" as "unpublished"
// would hide the entire public dataset. Retirement governs what can still be
// RUN, which is a different question and is enforced by the soft-delete cascade
// in the database.
export function scenarioIsPublic(scenario, family) {
  if (!scenario?.is_public) return false;
  return familyIsPublic(family);
}

// The set every run check is resolved against. Built once per request from the
// two small tables rather than queried per run.
export function publicScenarioIds(scenarios = [], families = []) {
  const familyById = new Map();
  for (const f of families || []) {
    if (f?.id) familyById.set(f.id, f);
  }
  const ids = new Set();
  for (const s of scenarios || []) {
    if (scenarioIsPublic(s, familyById.get(s?.family_id))) ids.add(s.scenario_id);
  }
  return ids;
}

// `publicIds` is the set above. Fails closed on a run whose scenario cannot be
// resolved at all: an unidentifiable run is not something to publish by
// default.
//
// The column comes first and the blob second on both ids, matching how
// /api/compare and /api/runs already read them — rows predating those columns
// carry only data.scenario_id, and a null ran_against_scenario_id means the run
// never moved, so it stands for the live id rather than for "no scenario".
export function runIsPublic(run, publicIds) {
  if (!run?.is_public) return false;
  // Never selected by callers that already filter it in the query; undefined
  // then, which is exactly what those queries guarantee. Checked anyway so a
  // future call site cannot publish a retired run by forgetting the filter.
  if (run.deleted_at) return false;

  const live = run.scenario_id ?? run.data?.scenario_id ?? null;
  if (!live) return false;
  const ranAgainst = run.ran_against_scenario_id ?? run.data?.scenario_id ?? live;

  return Boolean(publicIds?.has(live) && publicIds?.has(ranAgainst));
}
