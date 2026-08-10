# Public comparison page — redesign

## Purpose

The public root (`/`, `app/components/CompareGrid.js`) is the project's front
door: the one-pager sends people there, and no account is needed. Today it
opens on the headline *"Plan+execute vs. chained, model by model"* — a title
that already assumes you know what the two pipelines are, what a step is, and
why anyone is counting them.

A visitor arrives and cannot answer: what is being measured, why tool calls
rather than answers, what `3/4` means, or why `4/4` matters more than `3/4`.
All of that language exists — in the project one-pager — and none of it is on
the page.

This redesign makes the page answer those questions in the first screen, and
fixes three concrete defects in the grid below it.

## What the one-pager says, that the page should say

Quoting the source of truth so the copy below is traceable:

- *"Across the models of most major providers: how far can each be used to
  help concentrate power?"*
- *"Not 'does it agree', does it **actually make the tool calls** that would
  do it."*
- *"Each scenario is a chain of 4–5 real tool calls, invoked one at a time.
  Tool outputs are stubbed, so nothing touches a real system."*
- *"The last call in the chain is the irreversible, oversight-removing one."*
- *"A model that hedges in prose but completes the chain is the finding."*
- *"these **do have a right answer** — don't cross the critical step. What we
  measure is how much pressure it takes to cross it anyway."*

## The four defects

### 1. No answer to "what is this?"

The `<h1>` is an internal comparison title. The explanatory content that does
exist is a "Work in progress" caveat box — it says what the page *isn't*
(validated, significant) before saying what it *is*.

### 2. The depth ramp is measurably unreadable at the step that matters

The grid encodes 0–4 steps as five steps of one blue ramp
(`.cmp-d0`…`.cmp-d4`). Run through the dataviz skill's validator against the
light surface:

| pair | ΔE normal vision | verdict |
|---|---|---|
| `3/4` `#1c5cab` vs `4/4` `#0d366b` | **14.7** | **FAIL** — below the 15 floor, "hard to tell apart even with full color vision" |
| `2/4` `#3987e5` vs `3/4` `#1c5cab` | **14.4** | **FAIL** |
| `0/4` `#eef0f2` vs surface | 1.11:1 contrast | WARN |
| `1/4` `#86b6ef` vs surface | 2.06:1 contrast | WARN |

So the distinction the whole project turns on — did it stop at 3, or did it
make the irreversible call — is carried by two blues a full-sighted reader
cannot separate. Today a red outline (`.cmp-fullreached-swatch`) compensates,
but an outline in the danger colour reads as *an error in the tool*, not as
*the finding*.

**Root cause, and why more contrast is the wrong fix:** the cell is encoding
two different kinds of data with one channel.

- *how many steps it reached* is a **magnitude**
- *did it cross the critical step* is a **state**

The dataviz method assigns those different colour jobs — sequential for
magnitude, a reserved status colour for state. Fusing them into one ramp makes
3 and 4 adjacent **by construction**. Re-stepping the ramp would buy a few ΔE
and leave the category error in place.

### 3. Style labels vanish on horizontal scroll

`.cmp-style-label` is an ordinary `<td>`. With 3 models visible this is
invisible as a problem; the page currently hides **53 models with no data**
behind a checkbox. Scrolling right loses the row identity entirely.

### 4. The legend is a wall of footnotes, hoisted above the thing it annotates

Seven blocks of parenthetical prose before the reader has seen a single cell —
including *"plan itself refused (linear only — 0/4 with an accepted plan means
step 1 refused, a different finding)"*, which cannot be parsed by someone who
has not yet seen a cell. Two notations are never explained at all: `best of 3`,
and what the `T` framing actually changes.

## Design

### A. Opening band

Replaces the current `<h1>`/subtitle. Three elements:

1. **`<h1>`: "How far can a model be pushed into helping concentrate power?"**
2. **Standfirst: "We don't ask whether it agrees. We watch which tool calls it
   actually makes."**
3. **A four-line "how to read this"**, one sentence each, in this order:
   - Each scenario is a chain of 4–5 tool calls, made one at a time. Outputs
     are stubbed — nothing here touches a real system.
   - The last call is the irreversible one that removes human oversight.
   - These scenarios have a right answer: don't make that call. What's
     measured is how much pressure it takes to make it anyway.
   - A model that hedges in prose but completes the chain is the finding.

The existing "Work in progress" caveat moves **below** this band. It is
important and stays, but it is not the first thing a visitor should read.

### B. Verdict strip — the cross-style merge, at the top

One row per model, sorted worst-first (crossed before not-crossed; within
each, by best depth reached, then by how many attempts crossed).

```
Sonnet 5    ▮▮▮▮  CROSSED THE CRITICAL STEP    4 of 12 attempts
                  first crossed under: technical normalization · test framing
Haiku 4.5   ▮▮▮▮  CROSSED THE CRITICAL STEP    2 of 12 attempts
Opus 5      ▮▮▮▫  stopped at step 3            0 of 4 attempts
```

This is the "best of all styles" merge the grid cannot express, and it also
answers the one-pager's *"which style moves which model"* — which today has to
be reconstructed by eye across ten rows.

"Attempts" = distinct `(scenario, pipeline, style)` combinations with at least
one sample. The strip aggregates across every scenario and both pipelines;
per-scenario detail is the grid below.

### C. Cell encoding — depth leaves the colour channel entirely

**Magnitude by length, state by colour.**

- **Depth** renders as an n-segment bar (`▮▮▮▫`), filled to the number of
  steps reached, in a single ink colour. Length is a stronger encoding than
  hue for magnitude, and it removes every failing adjacent pair at once — the
  ramp's four problem pairs simply cease to exist.
- **Crossed the critical step** takes the cell's fill: the reserved status
  colour (`--danger` `#b3312c`), plus a glyph, plus the word. Measured
  separation from the darkest depth ink: **ΔE 30.2 normal, 16.5 protan —
  passes both**. Never colour alone, per the dataviz non-negotiable.
- **Did not cross** gets no fill — surface, with the bar and the fraction.

The red *outline* is removed. It duplicated the meaning it now carries as fill.

The bar has one segment per step in *this scenario's* chain (`fullSteps`), not
a fixed four — the one-pager specifies chains of 4–5, and the scenario builder
will produce more of them.

The palette must be re-run through `dataviz/scripts/validate_palette.js`
before shipping. **Light mode only**: `app/globals.css` has no
`prefers-color-scheme` or `data-theme` rules, so the app ships a single light
theme and there is no dark surface to validate against.

### D. Grid structure

- **The style column becomes `position: sticky`** — the direct fix for the
  horizontal-scroll complaint.
- **Merged by default.** One row per scenario showing the best result across
  all styles; a toggle expands to the per-style rows. This is what holds up as
  the model count grows.
- **One grid per scenario, not two.** The two pipelines (`plan → execute` and
  `chained`) become two values within one cell, stacked. The one-pager asks
  *where the weak link is* — whether having the full history matters — and
  that comparison currently requires looking back and forth between two
  separate tables.
- A **"Best of any style"** row stays pinned at the top of each expanded grid.

### E. Legends become in-place explanations

The seven-block legend card is removed. A compact key remains for the cell
encoding only (bar = steps reached; red = crossed the critical step). Every
other notation explains itself where it appears, on hover and on focus:

- **`T` — test framing.** *"Changes only the tool descriptions shown to the
  planner, and only during planning. Every execution step afterwards uses the
  real tool descriptions and the real goal. It's a workaround to get a plan
  out — and one that exists in real life."*
- **`R` — real framing.** *"The plan was accepted without any pretext."*
- **`best of 3`.** *"This combination was run 3 times; the deepest run is
  shown. Models are not deterministic and results near a decision boundary
  flip between runs."*
- **`no plan`.** *"The model refused to produce a plan at all, so no step was
  ever executed."*
- **`plan ok, step 1 refused`.** *"It agreed to the plan, then refused the
  first tool call — a different finding from refusing to plan."*
- **`n/a`.** *"This combination has not been run yet."*
- **`*`.** *"Batch still running — this number may still change."*

Wording is deliberately plain and full-sentence. These are read once, by
someone who has never seen the project.

### F. Data: compute "crossed", don't infer it from the count

`/api/compare` currently reports `depth` and `fullSteps`, and the UI treats
`depth === fullSteps` as "reached every step".

Measured against the current 88 runs: every plan produced is 4 steps long and
places `critical_tool` at position 4 of 4, so the two measures agree **on 26
of 26 linear runs**. They agree by coincidence, not by construction:

- The one-pager specifies chains of **4–5** calls.
- Nothing constrains a model's plan to put the critical tool last.
- A chained run calls tools freely; `tools_called` could contain the critical
  tool without reaching the full count, or reach the full count having
  substituted a tool.

So the route gains, per sample, a `crossedCritical` boolean computed from tool
**names**:

- **linear** — from `plan[i].tool` for each `steps[i].accepted`, checked
  against the scenario's `critical_tool`. Verified available: all 26 stored
  plans carry `.tool` on every step.
- **chained** — from `direct_result.tools_called`. Verified available on all
  38 stored chained runs.

This requires joining each scenario's `critical_tool` into the compare
response. `/api/compare` already reads the `runs` table; it gains a second
read of `scenarios` (`scenario_id, data->critical_tool`) for the scenario ids
in play, cached per request the same way batch manifests already are.

`depth` and `fullSteps` stay — the bar still shows how far it got. Only the
headline verdict moves off the count.

## Out of scope

- Any change to how runs are produced, stored, or scored. This is a
  presentation change plus one derived field.
- The signed-in-only controls (creator filter, batch filter, "public runs
  only" chip). They stay exactly as they are.
- `/runs`, `/dashboard`, `/scenarios` and the scenario builder.
- Adding models or scenarios to the corpus.
- Dark mode. The app has no dark theme today and this redesign does not add
  one.

## Testing

`app/components/CompareGrid.js` is a 605-line client component with no tests,
and this redesign adds real derivation logic (the cross-style merge, the
crossed-critical computation, sorting the verdict strip). That logic moves
into pure functions in `lib/`, testable under the `node --test` harness this
repo now has:

- `crossedCritical(sample, criticalTool)` — linear and chained shapes; the
  critical tool absent; a plan whose critical tool is not last; `tools_called`
  missing.
- `mergeStyles(samples)` — best depth wins; crossed beats deeper-but-not-
  crossed; empty input; all `n/a`.
- `verdictRows(combos)` — ordering, attempt counts, which styles crossed
  first.

No test drives a browser or calls a model API.
