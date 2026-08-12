# Scenario visibility: publication as a conjunction

**Date:** 12 August 2026
**Status:** design, awaiting implementation

## The problem

Publication currently flows *upward*. Three separate rules decide what an
anonymous visitor sees, and they disagree with each other:

| Surface | What it checks today |
|---|---|
| `/api/families` | the family's `is_public`. A published family publishes its whole dressing set. |
| `/api/scenario-detail` | the family's `is_public` **or** `hasPublicRun` — one published run unlocks the full spec, family published or not. |
| `/api/compare`, `/api/runs?id=` | the run's `is_public`, and nothing else. Neither the scenario nor the family is consulted. |

Two consequences follow.

**A published run already publishes its scenario, and nobody decided that.**
The stored blob holds the verbatim tool schemas and the whole transcript, so
the scenario text is in it either way; `hasPublicRun` then makes the leak
official by unlocking the spec page too.

**A scenario has no publication of its own.** A family is all-or-nothing. That
was survivable while the bank held five scenarios and one family. It stops
being survivable now: a planned `scripts/generate-scenarios.js` sweep is about
to insert up to 39 machine-written candidates into families that
are already `is_public = true`, which would publish every one of them the
moment it lands.

## The rule

Publication is a conjunction that descends. Each level requires its own flag
**and** every flag above it:

```
family visible    ⟺  family.is_public
scenario visible  ⟺  scenario.is_public  ∧  family visible
run visible       ⟺  run.is_public  ∧  both of its scenarios visible
```

"Both of its scenarios" is `scenario_id` and `ran_against_scenario_id`: after a
revision carries runs over, those are two different rows, and the transcript
discloses the text of the one it actually executed against. A run is published
under both names or under neither.

The run keeps its own flag. This adds two conditions, it removes none — a run
that nobody published stays unpublished however public its scenario is.

`hasPublicRun` is deleted rather than adapted. Under this rule a run can only be
public if its scenario already is, so the unlock can never fire; keeping it
would be dead code that states the opposite of the rule beside it.
`/api/scenario-detail` loses its two-ways-in branch and becomes one condition.

## Schema

```sql
alter table public.scenarios
  add column is_public boolean not null default false;

update public.scenarios set is_public = true;   -- the four rows that exist
```

`default false` means a **new** row arrives unpublished. Publication stays a
hand-written `update`, exactly as it is for `runs` and `scenario_families` — no
application code writes the flag, and this change does not add a UI toggle.

The backfill covers all four existing rows, **including the two soft-deleted
`_v0` rows**. See the first trap below.

## Where the rule lives

One module, `lib/publication.js`, imported by every read path — the same
discipline as `isRunnable` in `lib/families.js` and the exact-string set in
`lib/public-paths.js`. Three call sites deriving "visible" independently is how
the current three-way disagreement happened.

```js
export function familyIsPublic(family)                  // is_public && !deleted_at
export function scenarioIsPublic(scenario, family)      // scenario.is_public && familyIsPublic
export function publicScenarioIds(scenarios, families)  // Set<scenario_id>
export function runIsPublic(run, publicIds)             // run.is_public && both ids in the set
```

The predicates answer "is this published", not "may this caller see it". Call
sites keep their own `signedIn ||` in front, so a session still bypasses
publication the way it does today.

## Read paths

**`/api/families`** — select `is_public` on scenarios, and pass it through.
`buildFamilyView` gains `scenarioIsPublic` in the `canSeeScenario` guard it
already has. The counts follow the same guard, per the rule already written in
that file: a scenario an anonymous visitor cannot see must not be counted for
them either, "or the count becomes a side channel reporting how much
unpublished work exists".

**`/api/scenario-detail`** — `belongsToPublicFamily(...) || hasPublicRun(...)`
becomes `scenarioIsPublic(...)`. The scenario lookup must not filter
`deleted_at`; it already doesn't, for the reason in the second trap.

**`/api/compare`** — needs the scenario and family tables, which it does not
read today. Both are small (5 and 25 rows). Compute `publicScenarioIds` first,
then keep the existing query-level discipline by adding
`.in("scenario_id", ids)` alongside `.eq("is_public", true)`, so an
unpublishable run is never loaded into a response this request could serialise.
`ran_against_scenario_id` is checked after the fetch — two `.in()` filters
cannot express "null falls back to `scenario_id`", which is what a row predating
that column means.

**`/api/runs?id=`** — the anonymous guard becomes a single `runIsPublic(...)`,
which already carries the run's own flag. Same 404 as today whichever condition
fails, so the response still never distinguishes "unpublished" from "does not
exist".

## Three traps

**1. Soft-deleted scenarios carry the entire public dataset.** All 232 runs have
`ran_against_scenario_id` pointing at a `_v0` row that is soft-deleted, and
`scenario_id` pointing at the live `_v1`. If the conjunction reads `deleted_at`
as "not published", the public grid goes dark completely. So `is_public` is read
on retired rows without consulting `deleted_at` — the same asymmetry
`/api/scenario-detail` already applies when it loads a superseded spec, and for
the same reason: a retired row is the definition an older run actually saw.

**2. A revision must carry the flag forward.** Inserting `<id>_v2` without
copying `is_public` from the row it supersedes unpublishes the grid at the exact
moment the runs are carried over. This becomes a numbered step in the README's
"Revising a scenario", beside `supersedes` and `revision_note`.

**3. The counts.** Covered above, and it is the visible half of trap 1: if
scenario visibility changes, `scenarioCount` and `runCount` change with it or
they leak the size of the unpublished bank.

## Non-goals

- No UI for the flag. Publication is a deliberate hand-written `update`.
- No RLS policies. Access control still rests on the service-role key plus these
  checks, as documented.
- No change to what a signed-in caller sees.

## Tests

`tests/publication.test.js`, pure, no network: the conjunction at each level, a
soft-deleted-but-published scenario staying public, a run whose `ran_against`
is unpublished being hidden, and `ran_against` null falling back to
`scenario_id`. `tests/families.test.js` gains cases for an unpublished scenario
under a published family — absent from the list *and* from both counts.

## Documentation

The README's "What is public and what is not" section states the current
family-governs-scenario rule in three places. All three are rewritten around the
conjunction, and the publication snippet gains the `scenarios` update.
