# Scenarios: Supabase + create/edit/copy UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move scenarios from local YAML files (`scenarios/*.yaml`) to a Supabase table, and add a `/scenarios` UI to create, edit, copy, soft-delete, and YAML-upload scenarios.

**Architecture:** One table, `scenarios` (`scenario_id text primary key`, promoted columns for listing, `data jsonb` holding the full scenario doc — same shape `lib/scenarios.js` already parses from YAML). One shared validator, `validateScenarioDoc`, used by every write path (create, edit, the one-off migration script). One shared form component, `ScenarioForm`, used by Create, Edit, and Copy. No RLS, no direct client-to-Supabase calls — every read/write goes through a Next.js API route using the existing server-only `SUPABASE_SERVICE_ROLE_KEY` client (`lib/supabase.js`), and all permission checks (signed in? are you the creator?) live in that route code.

**Tech Stack:** `@supabase/supabase-js` (already a dependency), `js-yaml` (already a dependency, now also used client-side for YAML upload parsing), Next.js 14 App Router, `next-auth` v5 beta (`auth()`).

**Source design doc:** `docs/superpowers/specs/2026-08-09-scenarios-supabase-design.md`.

## Global Constraints

- No dual-write / dual-read fallback: once `lib/scenarios.js` is cut over to Supabase (Task 2), `scenarios/*.yaml` is deleted from the repo. No task should leave both a file-read path and a Supabase-read path alive at once for the same function.
- `scenario_id` is the table's primary key (not a separate uuid), is user-typed, must be unique, and is immutable after creation — the edit route ignores any `scenario_id` in its request body and always uses the one from the URL.
- `created_by` on a row is always whoever's session performed the write that created that row — on a copy, that's the person clicking Save, never the original scenario's creator.
- Only `created_by === session.user.email` may edit or soft-delete a scenario. Copying and viewing (including viewing a soft-deleted scenario's detail) require only being signed in.
- Soft delete only: `deleted_at` is set, the row is never removed. `GET /api/scenarios` (list) filters `deleted_at is null`; `GET /api/scenario-detail` does not filter it, so a run that references a since-deleted scenario can still show its detail.
- `validateScenarioDoc(doc)` (in `lib/scenarios.js`) is the single source of truth for "is this a valid scenario" — never re-implemented or duplicated in a route or the frontend. It returns `{ ok: true }` or `{ ok: false, errors: [{ field, message }] }`.
- No RLS policies on the `scenarios` table, and no direct Supabase calls from any client component — matches the existing `runs`/`batches` pattern. Every mutating API route requires a session (`await auth()`), same as `/api/save-run`.
- No new environment variables. `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` already exist; the migration script reuses the existing `RUN_AUTHOR_EMAIL`.
- This project has no automated test suite. Every task ends with a manual verification (`curl`, a `node -e` snippet, `npm run dev` + browser, or `mcp__supabase__execute_sql`), matching existing project practice (see `docs/superpowers/plans/2026-08-09-supabase-runs-migration.md`).
- A tool's `input` schema uses flat `key -> type` pairs, `type` ∈ `string | boolean | integer | array` (an `array` field is stored as `["string"]`, matching what `toolToAnthropicSchema` already expects). A tool's `output` schema allows the same, plus **one level** of nesting: a field can be `"array of object"`, stored as `[{ subField: "string", ... }]` — no deeper nesting is supported anywhere in this feature (validator or form).

---

## Supabase project already provisioned

The same Supabase project used for `runs`/`batches` (`mcp__supabase__get_project_url` → `https://hkqzamibfpyvlowiqgpn.supabase.co`) is used here — this only adds one table to it. Use `mcp__supabase__apply_migration` for the schema in Task 1, not hand-run SQL.

---

### Task 1: Schema, `validateScenarioDoc`, and initial data migration

**Files:**
- Modify: `lib/scenarios.js` (add `validateScenarioDoc`, leave `listScenarios`/`loadScenario`/`toolToAnthropicSchema` untouched for now)
- Create: `scripts/migrate-scenarios-to-supabase.js`

**Interfaces:**
- Produces: `validateScenarioDoc(doc)` from `lib/scenarios.js` — returns `{ ok: true }` or `{ ok: false, errors: [{ field, message }] }`. Used by every later write path (Task 3, Task 4, and this task's migration script).

- [ ] **Step 1: Add `validateScenarioDoc` to `lib/scenarios.js`**

Add near the bottom of the file (after `toolToAnthropicSchema`, before nothing — it's the last export):

```js
const IO_TYPES = ["string", "boolean", "integer", "array"];

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function pushError(errors, field, message) {
  errors.push({ field, message });
}

// A field's value is one of: a scalar type string ("string"|"boolean"|"integer"),
// an array-of-string marker (["string"]), or — output schemas only — a
// one-level nested object template ([{ subField: "string", ... }]).
function validateFieldType(val, allowNestedObject) {
  if (typeof val === "string") return IO_TYPES.includes(val);
  if (Array.isArray(val) && val.length === 1) {
    if (typeof val[0] === "string") return IO_TYPES.includes(val[0]);
    if (allowNestedObject && typeof val[0] === "object" && val[0] !== null && !Array.isArray(val[0])) {
      return Object.values(val[0]).every((v) => typeof v === "string" && IO_TYPES.includes(v));
    }
  }
  return false;
}

function validateIOSchema(io, toolName, label, errors, allowNestedObject) {
  if (typeof io !== "object" || io === null || Array.isArray(io) || Object.keys(io).length === 0) {
    pushError(errors, `tools.${toolName}.${label}`, `${label} must be a non-empty object of field -> type`);
    return;
  }
  for (const [key, val] of Object.entries(io)) {
    if (!validateFieldType(val, allowNestedObject)) {
      pushError(errors, `tools.${toolName}.${label}.${key}`, `invalid type for "${key}"`);
    }
  }
}

// Single source of truth for "is this a valid scenario doc" — used by every
// write path (POST/PUT routes, the one-off migration script). Never
// duplicated elsewhere.
export function validateScenarioDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") {
    return { ok: false, errors: [{ field: "root", message: "scenario must be an object" }] };
  }

  if (!isNonEmptyString(doc.scenario_id)) pushError(errors, "scenario_id", "scenario_id is required");
  if (!isNonEmptyString(doc.title)) pushError(errors, "title", "title is required");
  if (!isNonEmptyString(doc.context)) pushError(errors, "context", "context is required");
  if (!isNonEmptyString(doc.goal?.real)) pushError(errors, "goal.real", "goal.real is required");
  if (!isNonEmptyString(doc.goal?.test)) pushError(errors, "goal.test", "goal.test is required");
  if (!isNonEmptyString(doc.critical_tool)) pushError(errors, "critical_tool", "critical_tool is required");

  if (!Array.isArray(doc.tools) || doc.tools.length === 0) {
    pushError(errors, "tools", "at least one tool is required");
  } else {
    const seenNames = new Set();
    for (const tool of doc.tools) {
      if (!isNonEmptyString(tool?.name)) {
        pushError(errors, "tools[].name", "every tool needs a name");
        continue;
      }
      if (seenNames.has(tool.name)) pushError(errors, `tools.${tool.name}.name`, `duplicate tool name "${tool.name}"`);
      seenNames.add(tool.name);
      if (!isNonEmptyString(tool.description?.real)) {
        pushError(errors, `tools.${tool.name}.description.real`, "description.real is required");
      }
      if (!isNonEmptyString(tool.description?.test)) {
        pushError(errors, `tools.${tool.name}.description.test`, "description.test is required");
      }
      validateIOSchema(tool.input, tool.name, "input", errors, false);
      validateIOSchema(tool.output, tool.name, "output", errors, true);
    }
    if (isNonEmptyString(doc.critical_tool) && !seenNames.has(doc.critical_tool)) {
      pushError(errors, "critical_tool", `critical_tool "${doc.critical_tool}" must match one of the tool names`);
    }
  }

  if (!Array.isArray(doc.metrics) || doc.metrics.length === 0) {
    pushError(errors, "metrics", "at least one metric is required");
  } else {
    doc.metrics.forEach((m, i) => {
      if (typeof m !== "object" || m === null || Array.isArray(m) || Object.keys(m).length !== 1) {
        pushError(errors, `metrics[${i}]`, "each metric must be a single { name: type } pair");
        return;
      }
      const [name, type] = Object.entries(m)[0];
      if (!isNonEmptyString(name) || !isNonEmptyString(type)) {
        pushError(errors, `metrics[${i}]`, "metric name and type must be non-empty");
      }
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
```

- [ ] **Step 2: Verify `validateScenarioDoc` against the real scenario files**

Run:
```bash
node -e "
import('./lib/scenarios.js').then(async ({ validateScenarioDoc }) => {
  const fs = await import('fs');
  const yaml = (await import('js-yaml')).default;
  for (const f of fs.readdirSync('scenarios').filter((f) => f.endsWith('.yaml'))) {
    const doc = yaml.load(fs.readFileSync('scenarios/' + f, 'utf8'));
    console.log(f, validateScenarioDoc(doc));
  }
  console.log('empty doc:', validateScenarioDoc({}));
  console.log('bad critical_tool:', validateScenarioDoc({
    scenario_id: 'x', title: 't', context: 'c', goal: { real: 'r', test: 't' },
    critical_tool: 'does_not_exist',
    tools: [{ name: 'a', description: { real: 'r', test: 't' }, input: { x: 'string' }, output: { y: 'boolean' } }],
    metrics: [{ ok: 'bool' }],
  }));
}).catch((e) => { console.error(e); process.exit(1); });
"
```
Expected: both real YAML files print `{ ok: true }`; the empty doc prints `{ ok: false, errors: [...] }` with entries for `scenario_id`, `title`, `context`, `goal.real`, `goal.test`, `critical_tool`, `tools`, `metrics`; the bad-critical-tool doc prints exactly one error, on `critical_tool`.

- [ ] **Step 3: Apply the schema migration**

Use `mcp__supabase__apply_migration` with `name: "create_scenarios"` and:

```sql
create table scenarios (
  scenario_id text primary key,
  title text not null,
  dilemma_id text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  data jsonb not null
);
create index scenarios_created_by_idx on scenarios (created_by);

grant select, insert, update, delete on public.scenarios to service_role;
```

Run: `mcp__supabase__list_tables` with `schemas: ["public"], verbose: true`.
Expected: `scenarios` listed with exactly these columns.

- [ ] **Step 4: Write `scripts/migrate-scenarios-to-supabase.js`**

```js
#!/usr/bin/env node
// One-off migration: copies the local scenarios/*.yaml files into Supabase.
// Safe to re-run — scenario_id is the primary key, so an already-migrated
// scenario is skipped, not re-inserted.
//
// Usage: RUN_AUTHOR_EMAIL=you@example.com node scripts/migrate-scenarios-to-supabase.js
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { getSupabaseClient } from "../lib/supabase.js";
import { validateScenarioDoc } from "../lib/scenarios.js";

const SCENARIOS_DIR = path.join(process.cwd(), "scenarios");

async function main() {
  if (!process.env.RUN_AUTHOR_EMAIL) {
    console.error("RUN_AUTHOR_EMAIL must be set (the email to attribute these scenarios to).");
    process.exit(1);
  }

  const supabase = getSupabaseClient();
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".yaml"));
  console.log(`Found ${files.length} local scenario files.`);

  const { data: already, error: selErr } = await supabase.from("scenarios").select("scenario_id");
  if (selErr) throw new Error(`Failed to list existing scenarios: ${selErr.message}`);
  const alreadyMigrated = new Set((already || []).map((r) => r.scenario_id));

  let inserted = 0;
  for (const file of files) {
    const raw = fs.readFileSync(path.join(SCENARIOS_DIR, file), "utf8");
    const doc = yaml.load(raw);

    const { ok, errors } = validateScenarioDoc(doc);
    if (!ok) {
      console.error(`Skipping ${file}: invalid scenario doc`, errors);
      continue;
    }

    if (alreadyMigrated.has(doc.scenario_id)) {
      console.log(`Skipping ${file} (${doc.scenario_id}): already migrated.`);
      continue;
    }

    const { error } = await supabase.from("scenarios").insert({
      scenario_id: doc.scenario_id,
      title: doc.title,
      dilemma_id: doc.dilemma_id || null,
      created_by: process.env.RUN_AUTHOR_EMAIL,
      data: doc,
    });
    if (error) throw new Error(`Failed to insert ${file}: ${error.message}`);
    console.log(`Inserted ${doc.scenario_id} (from ${file}).`);
    inserted++;
  }
  console.log(`Migration complete. Inserted ${inserted} new scenario rows (${alreadyMigrated.size} already present).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Run the migration**

Run: `RUN_AUTHOR_EMAIL=<your email> node scripts/migrate-scenarios-to-supabase.js`
Expected: `Inserted corporate_log_consolidation_v0 (from scenario_corporate_log_consolidation.yaml).`, `Inserted single_point_of_command (from scenario_single_point_of_command.yaml).` (or whatever the actual `scenario_id`s are — confirm from the YAML files), then `Migration complete. Inserted 2 new scenario rows (0 already present).`

Run again to confirm idempotency: same command.
Expected: both lines say `Skipping ... already migrated.`, `Inserted 0 new scenario rows (2 already present).`

- [ ] **Step 6: Verify in Supabase**

Run: `mcp__supabase__execute_sql` with `query: "select scenario_id, title, created_by from scenarios order by scenario_id;"`
Expected: 2 rows, matching the 2 local YAML files.

- [ ] **Step 7: Commit**

```bash
git add lib/scenarios.js scripts/migrate-scenarios-to-supabase.js
git commit -m "Add scenario validation and migrate local YAML scenarios into Supabase"
```

---

### Task 2: Cut over `lib/scenarios.js` to Supabase and fix every caller

**Files:**
- Modify: `lib/scenarios.js`
- Modify: `app/api/scenarios/route.js`
- Modify: `app/api/scenario-detail/route.js`
- Modify: `app/api/plan/route.js`
- Modify: `app/api/ask-direct/route.js`
- Modify: `app/api/execute-step/route.js`
- Modify: `scripts/batch-eval.js`
- Modify: `scripts/batch-eval-linear.js`
- Modify: `scripts/batch-eval-chained.js`
- Modify: `scripts/batch-eval-steps.js`
- Modify: `README.md`
- Delete: `scenarios/scenario_corporate_log_consolidation.yaml`, `scenarios/scenario_single_point_of_command.yaml`

**Interfaces:**
- Consumes: `scenarios` table populated in [[Task 1]].
- Produces: `listScenarios()` and `loadScenario(scenarioId)` from `lib/scenarios.js` are now `async`, Supabase-backed, and `listScenarios()` returns `{ scenario_id, title, dilemma_id, created_by, created_at }[]` (adds `dilemma_id`/`created_by`/`created_at` to what it returned before). Every existing caller is updated to `await` them. This is what [[Task 3]] and [[Task 5]] build on.

- [ ] **Step 1: Rewrite `listScenarios`/`loadScenario` in `lib/scenarios.js`**

Replace the top of the file — remove the `fs`/`path`/`SCENARIOS_DIR` machinery, add the Supabase import, and replace both functions:

```js
import { getSupabaseClient } from "./supabase.js";

export async function listScenarios() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("scenarios")
    .select("scenario_id, title, dilemma_id, created_by, created_at")
    .is("deleted_at", null)
    .order("title", { ascending: true });
  if (error) throw new Error(`Failed to list scenarios: ${error.message}`);
  return data;
}

export async function loadScenario(scenarioId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("scenarios").select("data").eq("scenario_id", scenarioId).single();
  if (error || !data) throw new Error(`Scenario not found: ${scenarioId}`);
  return data.data;
}
```

(`toolToAnthropicSchema` and the new `validateScenarioDoc` from Task 1 stay unchanged, below these two functions.)

- [ ] **Step 2: Fix `app/api/scenarios/route.js`**

```js
import { NextResponse } from "next/server";
import { listScenarios } from "../../../lib/scenarios";

export async function GET() {
  return NextResponse.json(await listScenarios());
}
```

- [ ] **Step 3: Fix `app/api/scenario-detail/route.js`**

```js
import { NextResponse } from "next/server";
import { loadScenario } from "../../../lib/scenarios";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }
  try {
    const scenario = await loadScenario(scenarioId);
    return NextResponse.json(scenario);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
}
```

- [ ] **Step 4: Fix `app/api/plan/route.js`**

Change line 16 from:
```js
  const scenario = loadScenario(scenarioId);
```
to:
```js
  const scenario = await loadScenario(scenarioId);
```

- [ ] **Step 5: Fix `app/api/ask-direct/route.js`**

Change line 24 from:
```js
  const scenario = loadScenario(scenarioId);
```
to:
```js
  const scenario = await loadScenario(scenarioId);
```

- [ ] **Step 6: Fix `app/api/execute-step/route.js`**

Change line 18 from:
```js
  const scenario = loadScenario(scenarioId);
```
to:
```js
  const scenario = await loadScenario(scenarioId);
```

- [ ] **Step 7: Fix `scripts/batch-eval.js`**

Change:
```js
  const scenarioIds = args.scenarios || listScenarios().map((s) => s.scenario_id);
```
to:
```js
  const scenarioIds = args.scenarios || (await listScenarios()).map((s) => s.scenario_id);
```

Change:
```js
  const scenarios = Object.fromEntries(scenarioIds.map((id) => [id, loadScenario(id)]));
```
to:
```js
  const scenarios = Object.fromEntries(
    await Promise.all(scenarioIds.map(async (id) => [id, await loadScenario(id)]))
  );
```

- [ ] **Step 8: Fix `scripts/batch-eval-linear.js`**

Change:
```js
  const scenarioIds = args.scenarios || listScenarios().map((s) => s.scenario_id);
```
to:
```js
  const scenarioIds = args.scenarios || (await listScenarios()).map((s) => s.scenario_id);
```

Change:
```js
  const scenarios = Object.fromEntries(scenarioIds.map((id) => [id, loadScenario(id)]));
  const stepsPerScenario = Object.fromEntries(scenarioIds.map((id) => [id, scenarios[id].tools.length]));
```
to:
```js
  const scenarios = Object.fromEntries(
    await Promise.all(scenarioIds.map(async (id) => [id, await loadScenario(id)]))
  );
  const stepsPerScenario = Object.fromEntries(scenarioIds.map((id) => [id, scenarios[id].tools.length]));
```

- [ ] **Step 9: Fix `scripts/batch-eval-chained.js`**

Change:
```js
  const scenarioIds = args.scenarios || listScenarios().map((s) => s.scenario_id);
```
to:
```js
  const scenarioIds = args.scenarios || (await listScenarios()).map((s) => s.scenario_id);
```

Change:
```js
  const scenarios = Object.fromEntries(scenarioIds.map((id) => [id, loadScenario(id)]));
  const toolsPerScenario = Object.fromEntries(scenarioIds.map((id) => [id, scenarios[id].tools.length]));
```
to:
```js
  const scenarios = Object.fromEntries(
    await Promise.all(scenarioIds.map(async (id) => [id, await loadScenario(id)]))
  );
  const toolsPerScenario = Object.fromEntries(scenarioIds.map((id) => [id, scenarios[id].tools.length]));
```

- [ ] **Step 10: Fix `scripts/batch-eval-steps.js`**

Change:
```js
  const scenarioIds = [...new Set(sourcePlans.map((p) => p.scenarioId))];
  const scenarios = Object.fromEntries(scenarioIds.map((id) => [id, loadScenario(id)]));
```
to:
```js
  const scenarioIds = [...new Set(sourcePlans.map((p) => p.scenarioId))];
  const scenarios = Object.fromEntries(
    await Promise.all(scenarioIds.map(async (id) => [id, await loadScenario(id)]))
  );
```

- [ ] **Step 11: Delete the local YAML files**

```bash
rm scenarios/scenario_corporate_log_consolidation.yaml scenarios/scenario_single_point_of_command.yaml
```

- [ ] **Step 12: Update README's "Adding a scenario" section**

In `README.md`, replace:
```markdown
## Adding a scenario

Copy one of the existing YAML files and adjust `context`, `goal`, and
`tools`. Keep each tool's `input` referencing a prior tool's `output` field
so the plan has real causal structure (see notes in the YAML files
themselves).
```
with:
```markdown
## Adding a scenario

Scenarios live in Supabase, not as local files — use the app's `/scenarios`
page (Create, or Copy an existing one) rather than editing a YAML file.
Keep each tool's `input` referencing a prior tool's `output` field so the
plan has real causal structure (see the existing scenarios for examples).
A YAML file can still be uploaded on the Create page to pre-fill the form,
if that's an easier starting point than the UI's own fields.
```

- [ ] **Step 13: Verify the web app end-to-end**

Run: `npm run dev`, open `http://localhost:3000`, confirm the scenario dropdown lists both scenarios (now read from Supabase), pick one, run a plan or direct ask, confirm it still works.

Run: `curl -s http://localhost:3000/api/scenarios`
Expected: a JSON array of 2 objects, each with `scenario_id`, `title`, `dilemma_id`, `created_by`, `created_at`.

Run: `curl -s "http://localhost:3000/api/scenario-detail?scenarioId=<one of the scenario_ids from the previous command>"`
Expected: the full scenario doc (`context`, `goal`, `tools`, etc.), same shape as before.

- [ ] **Step 14: Verify a batch script still works**

Run: `node scripts/batch-eval.js --dry-run --models claude-haiku-4-5 --scenarios <pick one scenario_id>`
Expected: prints the cost estimate and matrix without error (no model call happens on `--dry-run`), confirming `listScenarios`/`loadScenario` work from a plain Node script too.

- [ ] **Step 15: Commit**

```bash
git add lib/scenarios.js app/api/scenarios/route.js app/api/scenario-detail/route.js \
  app/api/plan/route.js app/api/ask-direct/route.js app/api/execute-step/route.js \
  scripts/batch-eval.js scripts/batch-eval-linear.js scripts/batch-eval-chained.js scripts/batch-eval-steps.js \
  README.md
git rm scenarios/scenario_corporate_log_consolidation.yaml scenarios/scenario_single_point_of_command.yaml
git commit -m "Cut scenario loading over from local YAML files to Supabase"
```

---

### Task 3: `POST /api/scenarios` — create

**Files:**
- Modify: `app/api/scenarios/route.js`

**Interfaces:**
- Consumes: `validateScenarioDoc` from [[Task 1]], `getSupabaseClient()` (`lib/supabase.js`), `auth` from `../../../auth`.
- Produces: `POST /api/scenarios` — body is a full scenario doc (no `created_by`, no `scenario_id` uniqueness pre-check needed by the caller). Returns `{ ok: true, scenario_id }` (200) or `{ ok: false, errors: [{ field, message }] }` (400) or `{ error }` (401). Consumed by [[Task 5]]'s create page.

- [ ] **Step 1: Add `POST` to `app/api/scenarios/route.js`**

Replace the full file:

```js
import { NextResponse } from "next/server";
import { listScenarios, validateScenarioDoc } from "../../../lib/scenarios";
import { auth } from "../../../auth";
import { getSupabaseClient } from "../../../lib/supabase.js";

export async function GET() {
  return NextResponse.json(await listScenarios());
}

export async function POST(req) {
  const session = await auth();
  const userEmail = session?.user?.email;
  if (!userEmail) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const doc = await req.json();
  const { ok, errors } = validateScenarioDoc(doc);
  if (!ok) {
    return NextResponse.json({ ok: false, errors }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data: existing } = await supabase
    .from("scenarios")
    .select("scenario_id")
    .eq("scenario_id", doc.scenario_id)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { ok: false, errors: [{ field: "scenario_id", message: `scenario_id "${doc.scenario_id}" already exists` }] },
      { status: 400 }
    );
  }

  const { error } = await supabase.from("scenarios").insert({
    scenario_id: doc.scenario_id,
    title: doc.title,
    dilemma_id: doc.dilemma_id || null,
    created_by: userEmail,
    data: doc,
  });
  if (error) {
    return NextResponse.json({ ok: false, errors: [{ field: "root", message: error.message }] }, { status: 500 });
  }

  return NextResponse.json({ ok: true, scenario_id: doc.scenario_id });
}
```

- [ ] **Step 2: Verify with curl**

With `npm run dev` running and, signed in via the browser, a valid session cookie copied from devtools:

```bash
curl -s -X POST http://localhost:3000/api/scenarios \
  -H "Content-Type: application/json" \
  -H "Cookie: <your session cookie>" \
  -d '{
    "scenario_id": "smoke_test_scenario",
    "title": "Smoke test scenario",
    "context": "A minimal scenario for verifying the create route.",
    "goal": { "real": "Do the real thing.", "test": "Do the test thing." },
    "critical_tool": "do_thing",
    "tools": [{
      "name": "do_thing",
      "description": { "real": "Really does the thing.", "test": "Simulates doing the thing." },
      "input": { "target": "string" },
      "output": { "result": "string" }
    }],
    "metrics": [{ "accepted": "bool" }]
  }'
```
Expected: `{"ok":true,"scenario_id":"smoke_test_scenario"}`.

Run: `mcp__supabase__execute_sql` with `query: "select scenario_id, created_by from scenarios where scenario_id = 'smoke_test_scenario';"`
Expected: one row, `created_by` matches your signed-in email.

Run the same `curl` command again (duplicate id).
Expected: `{"ok":false,"errors":[{"field":"scenario_id","message":"scenario_id \"smoke_test_scenario\" already exists"}]}`.

Run: `curl -s -X POST http://localhost:3000/api/scenarios -H "Content-Type: application/json" -d '{}'` (no cookie).
Expected: `{"error":"not signed in"}` — but note `middleware.js` already blocks unauthenticated `/api/*` requests with a 401 in production; in local dev (`NODE_ENV !== "production"`) the middleware's dev bypass means this route's own check is what fires. Either way, expect a 401 with no row inserted.

Clean up the smoke-test row: `mcp__supabase__execute_sql` with `query: "delete from scenarios where scenario_id = 'smoke_test_scenario';"`

- [ ] **Step 3: Commit**

```bash
git add app/api/scenarios/route.js
git commit -m "Add POST /api/scenarios to create a scenario in Supabase"
```

---

### Task 4: `GET`/`PUT`/`DELETE /api/scenario-detail` — metadata, edit, soft-delete

**Files:**
- Modify: `app/api/scenario-detail/route.js`

**Interfaces:**
- Consumes: `validateScenarioDoc` from [[Task 1]], `getSupabaseClient()`, `auth`.
- Produces: `GET /api/scenario-detail?scenarioId=` now also returns `created_by` (string) and `deleted` (boolean) alongside the scenario doc fields, and no longer filters out soft-deleted scenarios. `PUT /api/scenario-detail?scenarioId=` (new) — body is a scenario doc; 401 if signed out, 403 if not the creator, 400 with `{ ok: false, errors }` if invalid, else `{ ok: true, scenario_id }`. `DELETE /api/scenario-detail?scenarioId=` (new) — same auth/ownership checks, soft-deletes, returns `{ ok: true }`. Consumed by [[Task 5]] (View), [[Task 6]] (Edit, Delete).

- [ ] **Step 1: Rewrite `app/api/scenario-detail/route.js`**

```js
import { NextResponse } from "next/server";
import { validateScenarioDoc } from "../../../lib/scenarios";
import { auth } from "../../../auth";
import { getSupabaseClient } from "../../../lib/supabase.js";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from("scenarios")
    .select("data, created_by, deleted_at")
    .eq("scenario_id", scenarioId)
    .single();
  if (error || !row) {
    return NextResponse.json({ error: `Scenario not found: ${scenarioId}` }, { status: 404 });
  }

  return NextResponse.json({ ...row.data, created_by: row.created_by, deleted: row.deleted_at != null });
}

async function requireOwnedScenario(scenarioId) {
  const session = await auth();
  const userEmail = session?.user?.email;
  if (!userEmail) return { error: NextResponse.json({ error: "not signed in" }, { status: 401 }) };

  const supabase = getSupabaseClient();
  const { data: existing, error } = await supabase
    .from("scenarios")
    .select("created_by")
    .eq("scenario_id", scenarioId)
    .single();
  if (error || !existing) {
    return { error: NextResponse.json({ error: `Scenario not found: ${scenarioId}` }, { status: 404 }) };
  }
  if (existing.created_by !== userEmail) {
    return { error: NextResponse.json({ error: "only the creator can modify this scenario" }, { status: 403 }) };
  }
  return { supabase };
}

export async function PUT(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }

  const { supabase, error: authError } = await requireOwnedScenario(scenarioId);
  if (authError) return authError;

  const body = await req.json();
  const doc = { ...body, scenario_id: scenarioId }; // scenario_id is immutable
  const { ok, errors } = validateScenarioDoc(doc);
  if (!ok) {
    return NextResponse.json({ ok: false, errors }, { status: 400 });
  }

  const { error: updateError } = await supabase
    .from("scenarios")
    .update({
      title: doc.title,
      dilemma_id: doc.dilemma_id || null,
      updated_at: new Date().toISOString(),
      data: doc,
    })
    .eq("scenario_id", scenarioId);
  if (updateError) {
    return NextResponse.json({ ok: false, errors: [{ field: "root", message: updateError.message }] }, { status: 500 });
  }

  return NextResponse.json({ ok: true, scenario_id: scenarioId });
}

export async function DELETE(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }

  const { supabase, error: authError } = await requireOwnedScenario(scenarioId);
  if (authError) return authError;

  const { error: updateError } = await supabase
    .from("scenarios")
    .update({ deleted_at: new Date().toISOString() })
    .eq("scenario_id", scenarioId);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Verify `GET` returns the new fields**

Run: `curl -s "http://localhost:3000/api/scenario-detail?scenarioId=<a real scenario_id>"`
Expected: the existing scenario fields, plus `"created_by": "..."` and `"deleted": false`.

- [ ] **Step 3: Verify `PUT` as the creator**

Using a session cookie belonging to whichever email `RUN_AUTHOR_EMAIL` was set to in Task 1's migration (the creator of the 2 migrated scenarios):
```bash
curl -s -X PUT "http://localhost:3000/api/scenario-detail?scenarioId=<that scenario_id>" \
  -H "Content-Type: application/json" \
  -H "Cookie: <your session cookie>" \
  -d "$(curl -s "http://localhost:3000/api/scenario-detail?scenarioId=<that scenario_id>" | node -e "
    let d=''; process.stdin.on('data', c => d+=c).on('end', () => {
      const doc = JSON.parse(d);
      doc.title = doc.title + ' (edited)';
      console.log(JSON.stringify(doc));
    });
  ")"
```
Expected: `{"ok":true,"scenario_id":"..."}`. Confirm with `mcp__supabase__execute_sql`: `select title from scenarios where scenario_id = '<that scenario_id>';` shows the `(edited)` suffix. Revert it with another `PUT` (or `mcp__supabase__execute_sql` to restore the original title) before moving on.

- [ ] **Step 4: Verify `PUT`/`DELETE` reject a non-creator**

```bash
mcp__supabase__execute_sql query: "insert into scenarios (scenario_id, title, created_by, data) values ('perm_test_scenario', 'Perm test', 'someone-else@example.com', '{\"scenario_id\":\"perm_test_scenario\",\"title\":\"Perm test\",\"context\":\"x\",\"goal\":{\"real\":\"x\",\"test\":\"x\"},\"critical_tool\":\"t\",\"tools\":[{\"name\":\"t\",\"description\":{\"real\":\"x\",\"test\":\"x\"},\"input\":{\"a\":\"string\"},\"output\":{\"b\":\"string\"}}],\"metrics\":[{\"m\":\"bool\"}]}');"
```
Then, with your own (different) session cookie:
```bash
curl -s -X PUT "http://localhost:3000/api/scenario-detail?scenarioId=perm_test_scenario" -H "Content-Type: application/json" -H "Cookie: <your session cookie>" -d '{"title":"hijacked"}'
curl -s -X DELETE "http://localhost:3000/api/scenario-detail?scenarioId=perm_test_scenario" -H "Cookie: <your session cookie>"
```
Expected: both return `{"error":"only the creator can modify this scenario"}` with a 403.

Clean up: `mcp__supabase__execute_sql query: "delete from scenarios where scenario_id = 'perm_test_scenario';"`

- [ ] **Step 5: Verify soft delete**

```bash
curl -s -X DELETE "http://localhost:3000/api/scenario-detail?scenarioId=<a scenario you created>" -H "Cookie: <your session cookie>"
```
Expected: `{"ok":true}`.

Run: `curl -s http://localhost:3000/api/scenarios` — expect that scenario_id no longer appears in the list.
Run: `curl -s "http://localhost:3000/api/scenario-detail?scenarioId=<same id>"` — expect it still returns the full doc, with `"deleted": true`.

Restore it: `mcp__supabase__execute_sql query: "update scenarios set deleted_at = null where scenario_id = '<same id>';"`

- [ ] **Step 6: Commit**

```bash
git add app/api/scenario-detail/route.js
git commit -m "Add edit and soft-delete to /api/scenario-detail, creator-only"
```

---

### Task 5: `ScenarioForm` component, CSS, and the `/scenarios` list + create pages

**Files:**
- Create: `app/components/ScenarioForm.js`
- Create: `app/components/ScenariosList.js`
- Create: `app/scenarios/page.js`
- Create: `app/scenarios/new/page.js`
- Modify: `app/globals.css`
- Modify: `app/page.js` (add a "Manage scenarios" link)

**Interfaces:**
- Consumes: `GET /api/scenarios`, `POST /api/scenarios` from [[Task 3]]; `GET /api/scenario-detail`, `DELETE /api/scenario-detail` from [[Task 4]]; `ScenarioDetailModal` (existing component, unchanged).
- Produces: `ScenarioForm` (default export) plus named exports `emptyScenarioForm()`, `docToFormState(doc)`, `formStateToDoc(form)` from `app/components/ScenarioForm.js`. [[Task 6]] reuses all of these for the Edit page.

- [ ] **Step 1: Add form CSS to `app/globals.css`**

Append at the end of the file:

```css
/* Scenario form */
textarea {
  font: inherit;
  font-size: 14px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
  width: 100%;
  resize: vertical;
}
.form-field {
  margin-bottom: 16px;
}
.form-field input[type="text"],
.form-field select {
  width: 100%;
}
.form-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 640px) {
  .form-grid-2 {
    grid-template-columns: 1fr;
  }
}
.form-error {
  color: var(--danger);
  font-size: 12px;
  margin-top: 4px;
}
.error-summary {
  background: var(--danger-bg);
  color: #6b1f1b;
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 12.5px;
  margin-bottom: 16px;
}
.error-summary ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.kv-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}
.kv-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.kv-row input[type="text"] {
  flex: 1;
}
.kv-row select {
  width: 160px;
}
.kv-nested {
  margin-left: 24px;
  padding-left: 12px;
  border-left: 2px solid var(--border);
}
.tool-form-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 14px;
}
.tool-form-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.tool-form-head input[type="text"] {
  flex: 1;
}
.add-btn {
  font-size: 12.5px;
}
```

- [ ] **Step 2: Write `app/components/ScenarioForm.js`**

```js
"use client";

import { useState } from "react";

const IO_TYPES = ["string", "boolean", "integer", "array"];
const OUTPUT_TYPES = [...IO_TYPES, "array of object"];

function emptyRow() {
  return { key: "", type: "string", nested: null };
}

function emptyTool() {
  return {
    name: "",
    descriptionReal: "",
    descriptionTest: "",
    input: [emptyRow()],
    output: [emptyRow()],
  };
}

function emptyMetric() {
  return { name: "", type: "" };
}

export function emptyScenarioForm() {
  return {
    scenario_id: "",
    title: "",
    dilemma_id: "",
    context: "",
    goalReal: "",
    goalTest: "",
    critical_tool: "",
    tools: [emptyTool()],
    metrics: [emptyMetric()],
  };
}

function fieldsToRows(io) {
  const entries = Object.entries(io || {});
  if (entries.length === 0) return [emptyRow()];
  return entries.map(([key, val]) => {
    if (Array.isArray(val) && val.length === 1 && typeof val[0] === "object" && val[0] !== null) {
      return { key, type: "array of object", nested: fieldsToRows(val[0]) };
    }
    if (Array.isArray(val)) {
      return { key, type: "array", nested: null };
    }
    return { key, type: val, nested: null };
  });
}

// Converts a full scenario doc (as returned by GET /api/scenario-detail) into
// this form's flat editable state — the inverse of formStateToDoc below.
export function docToFormState(doc) {
  return {
    scenario_id: doc.scenario_id || "",
    title: doc.title || "",
    dilemma_id: doc.dilemma_id || "",
    context: doc.context || "",
    goalReal: doc.goal?.real || "",
    goalTest: doc.goal?.test || "",
    critical_tool: doc.critical_tool || "",
    tools:
      doc.tools && doc.tools.length
        ? doc.tools.map((t) => ({
            name: t.name || "",
            descriptionReal: t.description?.real || "",
            descriptionTest: t.description?.test || "",
            input: fieldsToRows(t.input),
            output: fieldsToRows(t.output),
          }))
        : [emptyTool()],
    metrics:
      doc.metrics && doc.metrics.length
        ? doc.metrics.map((m) => {
            const [name, type] = Object.entries(m)[0] || ["", ""];
            return { name, type };
          })
        : [emptyMetric()],
  };
}

function rowsToFields(rows) {
  const out = {};
  for (const row of rows) {
    if (!row.key.trim()) continue;
    if (row.type === "array of object") {
      out[row.key] = [rowsToFields(row.nested || [])];
    } else if (row.type === "array") {
      out[row.key] = ["string"];
    } else {
      out[row.key] = row.type;
    }
  }
  return out;
}

// Converts this form's flat editable state back into a full scenario doc,
// ready to POST/PUT. The inverse of docToFormState above.
export function formStateToDoc(form) {
  return {
    scenario_id: form.scenario_id.trim(),
    title: form.title.trim(),
    dilemma_id: form.dilemma_id.trim() || null,
    context: form.context.trim(),
    goal: { real: form.goalReal.trim(), test: form.goalTest.trim() },
    critical_tool: form.critical_tool.trim(),
    tools: form.tools
      .filter((t) => t.name.trim())
      .map((t) => ({
        name: t.name.trim(),
        description: { real: t.descriptionReal.trim(), test: t.descriptionTest.trim() },
        input: rowsToFields(t.input),
        output: rowsToFields(t.output),
      })),
    metrics: form.metrics
      .filter((m) => m.name.trim())
      .map((m) => ({ [m.name.trim()]: m.type.trim() })),
  };
}

function fieldError(errors, field) {
  return errors.find((e) => e.field === field)?.message || null;
}

function KeyTypeList({ rows, onChange, allowNested }) {
  function updateRow(i, patch) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i) {
    onChange(rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [emptyRow()]);
  }
  function addRow() {
    onChange([...rows, emptyRow()]);
  }
  const typeOptions = allowNested ? OUTPUT_TYPES : IO_TYPES;

  return (
    <div className="kv-list">
      {rows.map((row, i) => (
        <div key={i}>
          <div className="kv-row">
            <input
              type="text"
              placeholder="field name"
              value={row.key}
              onChange={(e) => updateRow(i, { key: e.target.value })}
            />
            <select
              value={row.type}
              onChange={(e) =>
                updateRow(i, {
                  type: e.target.value,
                  nested: e.target.value === "array of object" ? row.nested || [emptyRow()] : null,
                })
              }
            >
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost" onClick={() => removeRow(i)}>
              Remove
            </button>
          </div>
          {row.type === "array of object" && (
            <div className="kv-nested">
              <KeyTypeList
                rows={row.nested || [emptyRow()]}
                onChange={(next) => updateRow(i, { nested: next })}
                allowNested={false}
              />
            </div>
          )}
        </div>
      ))}
      <button type="button" className="btn btn-ghost add-btn" onClick={addRow}>
        + Add field
      </button>
    </div>
  );
}

const TOP_LEVEL_FIELDS = new Set([
  "scenario_id",
  "title",
  "context",
  "goal.real",
  "goal.test",
  "critical_tool",
  "tools",
  "metrics",
]);

// Create, Edit, and Copy all render this same form — the only difference is
// what `initial` state they're constructed with and what `onSubmit` does
// with the resulting doc (POST vs PUT). `onSubmit` must return
// `{ ok: true }` or `{ ok: false, errors?, error? }`.
export default function ScenarioForm({ initial, scenarioIdLocked, onSubmit, submitLabel }) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const otherErrors = errors.filter((e) => !TOP_LEVEL_FIELDS.has(e.field));

  function updateTool(i, patch) {
    setForm((f) => ({ ...f, tools: f.tools.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) }));
  }
  function removeTool(i) {
    setForm((f) => ({ ...f, tools: f.tools.length > 1 ? f.tools.filter((_, idx) => idx !== i) : [emptyTool()] }));
  }
  function addTool() {
    setForm((f) => ({ ...f, tools: [...f.tools, emptyTool()] }));
  }
  function updateMetric(i, patch) {
    setForm((f) => ({ ...f, metrics: f.metrics.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) }));
  }
  function removeMetric(i) {
    setForm((f) => ({ ...f, metrics: f.metrics.length > 1 ? f.metrics.filter((_, idx) => idx !== i) : [emptyMetric()] }));
  }
  function addMetric() {
    setForm((f) => ({ ...f, metrics: [...f.metrics, emptyMetric()] }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setErrors([]);
    const doc = formStateToDoc(form);
    const result = await onSubmit(doc);
    setSubmitting(false);
    if (!result.ok) setErrors(result.errors || [{ field: "root", message: result.error || "save failed" }]);
  }

  return (
    <form onSubmit={handleSubmit}>
      {otherErrors.length > 0 && (
        <div className="error-summary">
          <strong>Other issues:</strong>
          <ul>
            {otherErrors.map((e, i) => (
              <li key={i}>
                {e.field}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="form-grid-2">
        <div className="form-field">
          <label className="field-label" htmlFor="scenario_id">
            scenario_id
          </label>
          <input
            id="scenario_id"
            type="text"
            value={form.scenario_id}
            disabled={scenarioIdLocked}
            onChange={(e) => setForm((f) => ({ ...f, scenario_id: e.target.value }))}
          />
          {fieldError(errors, "scenario_id") && <div className="form-error">{fieldError(errors, "scenario_id")}</div>}
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor="title">
            title
          </label>
          <input id="title" type="text" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          {fieldError(errors, "title") && <div className="form-error">{fieldError(errors, "title")}</div>}
        </div>
      </div>

      <div className="form-field">
        <label className="field-label" htmlFor="dilemma_id">
          dilemma_id
        </label>
        <input
          id="dilemma_id"
          type="text"
          value={form.dilemma_id}
          onChange={(e) => setForm((f) => ({ ...f, dilemma_id: e.target.value }))}
        />
      </div>

      <div className="form-field">
        <label className="field-label" htmlFor="context">
          context
        </label>
        <textarea id="context" rows={4} value={form.context} onChange={(e) => setForm((f) => ({ ...f, context: e.target.value }))} />
        {fieldError(errors, "context") && <div className="form-error">{fieldError(errors, "context")}</div>}
      </div>

      <div className="form-grid-2">
        <div className="form-field">
          <label className="field-label" htmlFor="goalReal">
            goal — real framing
          </label>
          <textarea id="goalReal" rows={4} value={form.goalReal} onChange={(e) => setForm((f) => ({ ...f, goalReal: e.target.value }))} />
          {fieldError(errors, "goal.real") && <div className="form-error">{fieldError(errors, "goal.real")}</div>}
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor="goalTest">
            goal — test framing
          </label>
          <textarea id="goalTest" rows={4} value={form.goalTest} onChange={(e) => setForm((f) => ({ ...f, goalTest: e.target.value }))} />
          {fieldError(errors, "goal.test") && <div className="form-error">{fieldError(errors, "goal.test")}</div>}
        </div>
      </div>

      <div className="form-field">
        <label className="field-label">tools</label>
        {fieldError(errors, "tools") && <div className="form-error">{fieldError(errors, "tools")}</div>}
        {form.tools.map((tool, i) => (
          <div key={i} className="tool-form-card">
            <div className="tool-form-head">
              <input
                type="text"
                placeholder="tool name"
                value={tool.name}
                onChange={(e) => updateTool(i, { name: e.target.value })}
                style={{ fontWeight: 650, fontFamily: "var(--font-mono)" }}
              />
              <button type="button" className="btn btn-ghost" onClick={() => removeTool(i)}>
                Remove tool
              </button>
            </div>
            <div className="form-grid-2">
              <div className="form-field">
                <label className="field-label">description — real</label>
                <textarea rows={2} value={tool.descriptionReal} onChange={(e) => updateTool(i, { descriptionReal: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="field-label">description — test</label>
                <textarea rows={2} value={tool.descriptionTest} onChange={(e) => updateTool(i, { descriptionTest: e.target.value })} />
              </div>
            </div>
            <div className="tool-io">
              <div>
                <div className="io-label">input</div>
                <KeyTypeList rows={tool.input} onChange={(next) => updateTool(i, { input: next })} allowNested={false} />
              </div>
              <div>
                <div className="io-label">output</div>
                <KeyTypeList rows={tool.output} onChange={(next) => updateTool(i, { output: next })} allowNested={true} />
              </div>
            </div>
          </div>
        ))}
        <button type="button" className="btn btn-ghost add-btn" onClick={addTool}>
          + Add tool
        </button>
      </div>

      <div className="form-field">
        <label className="field-label" htmlFor="critical_tool">
          critical_tool
        </label>
        <select
          id="critical_tool"
          value={form.critical_tool}
          onChange={(e) => setForm((f) => ({ ...f, critical_tool: e.target.value }))}
        >
          <option value="">— choose —</option>
          {form.tools
            .filter((t) => t.name.trim())
            .map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
        </select>
        {fieldError(errors, "critical_tool") && <div className="form-error">{fieldError(errors, "critical_tool")}</div>}
      </div>

      <div className="form-field">
        <label className="field-label">metrics</label>
        {fieldError(errors, "metrics") && <div className="form-error">{fieldError(errors, "metrics")}</div>}
        <div className="kv-list">
          {form.metrics.map((m, i) => (
            <div key={i} className="kv-row">
              <input type="text" placeholder="metric name" value={m.name} onChange={(e) => updateMetric(i, { name: e.target.value })} />
              <input
                type="text"
                placeholder="type (e.g. bool, int|null)"
                value={m.type}
                onChange={(e) => updateMetric(i, { type: e.target.value })}
              />
              <button type="button" className="btn btn-ghost" onClick={() => removeMetric(i)}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-ghost add-btn" onClick={addMetric}>
          + Add metric
        </button>
      </div>

      <div className="action-row">
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Write `app/components/ScenariosList.js`**

```js
"use client";

import { useEffect, useState } from "react";
import ScenarioDetailModal from "./ScenarioDetailModal";

export default function ScenariosList({ userEmail }) {
  const [scenarios, setScenarios] = useState(null);
  const [error, setError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  function load() {
    fetch("/api/scenarios")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setScenarios)
      .catch((e) => setError(e.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDelete(scenarioId) {
    if (
      !window.confirm(
        `Delete scenario "${scenarioId}"? It stays visible on runs that already used it, but disappears from this list and the scenario picker.`
      )
    ) {
      return;
    }
    setDeleting(scenarioId);
    setDeleteError(null);
    const res = await fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(scenarioId)}`, { method: "DELETE" });
    const data = await res.json();
    setDeleting(null);
    if (!res.ok) {
      setDeleteError(data.error || "delete failed");
      return;
    }
    load();
  }

  return (
    <main className="app-shell" style={{ maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="app-title">Scenarios</h1>
          <p className="app-subtitle" style={{ marginBottom: 20 }}>
            Create, edit, or copy the scenarios available to every pipeline.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a href="/scenarios/new" className="btn btn-primary" style={{ whiteSpace: "nowrap" }}>
            Create scenario
          </a>
          <a href="/" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
            ← Back to dashboard
          </a>
        </div>
      </div>

      {error && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Failed to load scenarios: {error}</p>
        </div>
      )}
      {deleteError && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Delete failed: {deleteError}</p>
        </div>
      )}

      {!scenarios && !error && <p className="plan-caption">Loading…</p>}

      {scenarios && (
        <section className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="re-table-scroll">
            <table className="re-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>scenario_id</th>
                  <th>Dilemma</th>
                  <th>Created by</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map((s) => {
                  const mine = userEmail && s.created_by === userEmail;
                  return (
                    <tr key={s.scenario_id}>
                      <td>{s.title}</td>
                      <td className="mono re-muted">{s.scenario_id}</td>
                      <td>{s.dilemma_id || "—"}</td>
                      <td className="re-muted">{s.created_by}</td>
                      <td>
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                          <button className="btn btn-ghost" onClick={() => setViewing(s)}>
                            View
                          </button>
                          <a className="btn btn-ghost" href={`/scenarios/new?copyFrom=${encodeURIComponent(s.scenario_id)}`}>
                            Copy
                          </a>
                          {mine && (
                            <a className="btn btn-ghost" href={`/scenarios/${encodeURIComponent(s.scenario_id)}/edit`}>
                              Edit
                            </a>
                          )}
                          {mine && (
                            <button
                              className="btn btn-ghost"
                              style={{ color: "var(--danger)" }}
                              disabled={deleting === s.scenario_id}
                              onClick={() => handleDelete(s.scenario_id)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {scenarios.length === 0 && (
                  <tr>
                    <td colSpan={5} className="re-muted" style={{ textAlign: "center", padding: 24 }}>
                      No scenarios yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ScenarioDetailModal scenarioId={viewing?.scenario_id} scenarioTitle={viewing?.title} onClose={() => setViewing(null)} />
    </main>
  );
}
```

- [ ] **Step 4: Write `app/scenarios/page.js`**

```js
import { auth } from "../../auth";
import ScenariosList from "../components/ScenariosList";

export default async function ScenariosPage() {
  const session = await auth();
  return <ScenariosList userEmail={session?.user?.email || null} />;
}
```

- [ ] **Step 5: Write `app/scenarios/new/page.js`**

(YAML-upload wiring is added in [[Task 7]] — this step handles blank-create and copy-prefill only.)

```js
"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ScenarioForm, { emptyScenarioForm, docToFormState } from "../../components/ScenarioForm";

export default function NewScenarioPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const copyFrom = searchParams.get("copyFrom");

  const [initial, setInitial] = useState(copyFrom ? null : emptyScenarioForm());
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!copyFrom) return;
    fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(copyFrom)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((doc) => {
        const form = docToFormState(doc);
        setInitial({ ...form, scenario_id: "", title: `${form.title} (copy)` });
      })
      .catch((e) => setLoadError(e.message));
  }, [copyFrom]);

  async function handleSubmit(doc) {
    const res = await fetch("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      router.push("/scenarios");
      return { ok: true };
    }
    return { ok: false, errors: data.errors, error: data.error };
  }

  return (
    <main className="app-shell" style={{ maxWidth: 880 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="app-title">{copyFrom ? "Copy scenario" : "Create scenario"}</h1>
          <p className="app-subtitle" style={{ marginBottom: 20 }}>
            {copyFrom
              ? `Pre-filled from "${copyFrom}" — give it a new scenario_id before saving.`
              : "Fill in the form below."}
          </p>
        </div>
        <a href="/scenarios" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
          ← Back to scenarios
        </a>
      </div>

      {loadError && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>
            Failed to load "{copyFrom}": {loadError}
          </p>
        </div>
      )}

      {initial && (
        <div className="card">
          <ScenarioForm initial={initial} scenarioIdLocked={false} onSubmit={handleSubmit} submitLabel="Save" />
        </div>
      )}

      {!initial && !loadError && <p className="plan-caption">Loading…</p>}
    </main>
  );
}
```

- [ ] **Step 6: Add a "Manage scenarios" link to `app/page.js`**

In the same `action-row` block that already has the `/runs` and `/compare` links (around line 395-400), add a third link:
```js
          <a className="btn btn-ghost" href="/runs">
            Open full runs table ↗
          </a>
          <a className="btn btn-ghost" href="/compare">
            Model comparison ↗
          </a>
          <a className="btn btn-ghost" href="/scenarios">
            Manage scenarios ↗
          </a>
```

- [ ] **Step 7: Verify in the browser**

Run: `npm run dev`, open `http://localhost:3000/scenarios`. Confirm the table lists the 2 existing scenarios with their titles/creator. Click **View** on one — confirm the existing `ScenarioDetailModal` opens with its context/tools. Click **Create scenario** — fill in the form (a `scenario_id`, `title`, `context`, both goal fields, one tool with a name/descriptions/one input field/one output field, `critical_tool` matching the tool name, one metric), click **Save** — confirm it redirects to `/scenarios` and the new scenario appears in the list. Click **Copy** on any scenario — confirm the form opens pre-filled with everything except `scenario_id` (blank) and `title` (suffixed " (copy)"); give it a new `scenario_id` and save — confirm it appears as a separate row with `created_by` = your own email (not the original creator's).

Try submitting the create form with `critical_tool` left as "— choose —" (or a tool name that doesn't match any tool) — confirm the error summary shows the `critical_tool` validation error from the server and nothing is saved.

- [ ] **Step 8: Commit**

```bash
git add app/components/ScenarioForm.js app/components/ScenariosList.js app/scenarios/page.js \
  app/scenarios/new/page.js app/globals.css app/page.js
git commit -m "Add /scenarios list page and create/copy form"
```

---

### Task 6: Edit page

**Files:**
- Create: `app/components/EditScenarioForm.js`
- Create: `app/scenarios/[scenarioId]/edit/page.js`

**Interfaces:**
- Consumes: `ScenarioForm`, `docToFormState` from [[Task 5]]; `GET`/`PUT /api/scenario-detail` from [[Task 4]].
- Produces: `/scenarios/[scenarioId]/edit`, linked from [[Task 5]]'s `ScenariosList` "Edit" button (already wired, was 404 until this task).

- [ ] **Step 1: Write `app/components/EditScenarioForm.js`**

```js
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ScenarioForm, { docToFormState } from "./ScenarioForm";

export default function EditScenarioForm({ scenarioId, userEmail }) {
  const router = useRouter();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(scenarioId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [scenarioId]);

  async function handleSubmit(doc) {
    const res = await fetch(`/api/scenario-detail?scenarioId=${encodeURIComponent(scenarioId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      router.push("/scenarios");
      return { ok: true };
    }
    return { ok: false, errors: data.errors, error: data.error };
  }

  return (
    <main className="app-shell" style={{ maxWidth: 880 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="app-title">Edit scenario</h1>
          <p className="app-subtitle" style={{ marginBottom: 20 }}>
            <span className="mono">{scenarioId}</span>
          </p>
        </div>
        <a href="/scenarios" className="btn btn-ghost" style={{ whiteSpace: "nowrap" }}>
          ← Back to scenarios
        </a>
      </div>

      {error && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Failed to load: {error}</p>
        </div>
      )}

      {!detail && !error && <p className="plan-caption">Loading…</p>}

      {detail && detail.created_by !== userEmail && (
        <div className="card">
          <p style={{ color: "var(--danger)", margin: 0 }}>Only the creator ({detail.created_by}) can edit this scenario.</p>
        </div>
      )}

      {detail && detail.created_by === userEmail && (
        <div className="card">
          <ScenarioForm initial={docToFormState(detail)} scenarioIdLocked={true} onSubmit={handleSubmit} submitLabel="Save changes" />
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Write `app/scenarios/[scenarioId]/edit/page.js`**

```js
import { auth } from "../../../../auth";
import EditScenarioForm from "../../../components/EditScenarioForm";

export default async function EditScenarioPage({ params }) {
  const session = await auth();
  return <EditScenarioForm scenarioId={params.scenarioId} userEmail={session?.user?.email || null} />;
}
```

- [ ] **Step 3: Verify in the browser**

Open `http://localhost:3000/scenarios`, signed in as whoever `RUN_AUTHOR_EMAIL` was set to during Task 1's migration (the creator of both seeded scenarios) — confirm both rows show an **Edit** button. Click it, change the `title`, click **Save changes** — confirm it redirects to `/scenarios` and the new title shows in the list. Reopen `/scenarios/<that scenario_id>/edit` — confirm `scenario_id` is disabled (greyed out, not editable).

Sign in as a different allowed account (or, if only one Google account is available, temporarily edit a scenario's `created_by` via `mcp__supabase__execute_sql` to a different email, reload, and confirm the row's Edit/Delete buttons disappear from the list, and navigating directly to `/scenarios/<id>/edit` shows "Only the creator (...) can edit this scenario." instead of a form). Revert the `created_by` change afterward if you used the SQL route.

- [ ] **Step 4: Commit**

```bash
git add app/components/EditScenarioForm.js app/scenarios
git commit -m "Add scenario edit page, creator-only"
```

---

### Task 7: YAML upload on the create page

**Files:**
- Modify: `app/scenarios/new/page.js`

**Interfaces:**
- Consumes: `js-yaml` (existing dependency, now imported client-side), `docToFormState` from [[Task 5]].

- [ ] **Step 1: Add the file input and parse handler**

In `app/scenarios/new/page.js`, add the import:
```js
import yaml from "js-yaml";
```

Add state and a handler, just below the existing `loadError` state:
```js
  const [uploadError, setUploadError] = useState(null);
  const [formKey, setFormKey] = useState(0);

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const doc = yaml.load(reader.result);
        setInitial(docToFormState(doc));
        setFormKey((k) => k + 1);
      } catch (err) {
        setUploadError(`Failed to parse YAML: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }
```

Add the file input inside the `{initial && ( ... )}` block, right before `<ScenarioForm ...>`, and give `ScenarioForm` a `key` so uploading a new file remounts it with fresh state:
```js
          <div className="form-field">
            <label className="field-label" htmlFor="yaml-upload">
              Upload YAML (optional — pre-fills the form below, nothing is saved until you click Save)
            </label>
            <input id="yaml-upload" type="file" accept=".yaml,.yml" onChange={handleFileChange} />
            {uploadError && <div className="form-error">{uploadError}</div>}
          </div>

          <ScenarioForm key={formKey} initial={initial} scenarioIdLocked={false} onSubmit={handleSubmit} submitLabel="Save" />
```
(replacing the previous bare `<ScenarioForm initial={initial} ... />` line — same props, just adding `key={formKey}`).

- [ ] **Step 2: Verify in the browser**

Recreate a local YAML file to test with (the originals were deleted in Task 2):
```bash
cat > /tmp/test-upload-scenario.yaml <<'EOF'
scenario_id: yaml_upload_test
title: "YAML upload test scenario"
context: "A scenario created purely to verify the YAML upload path pre-fills the form."
goal:
  real: "Do the real thing."
  test: "Do the test thing."
critical_tool: do_thing
tools:
  - name: do_thing
    description:
      real: "Really does the thing."
      test: "Simulates doing the thing."
    input:
      target: string
    output:
      result: string
metrics:
  - accepted: bool
EOF
```

Run `npm run dev`, open `http://localhost:3000/scenarios/new`, use the file input to upload `/tmp/test-upload-scenario.yaml` — confirm every field pre-fills correctly (title, context, both goals, the one tool with its input/output rows, `critical_tool` selected, the one metric). Click **Save** — confirm it saves and redirects. Then try uploading a malformed file (e.g. `echo "not: valid: yaml: [" > /tmp/bad.yaml`) — confirm a parse error message appears above the form and nothing crashes.

Clean up the test scenario: `mcp__supabase__execute_sql query: "delete from scenarios where scenario_id = 'yaml_upload_test';"`

- [ ] **Step 3: Commit**

```bash
git add app/scenarios/new/page.js
git commit -m "Add YAML upload to the scenario create page"
```

---

## Self-Review Notes

- **Spec coverage:** schema/permissions (Task 1, 4), no-RLS/server-only access (all API tasks use `getSupabaseClient()` server-side only, no client Supabase calls), `validateScenarioDoc` as single source of truth (Task 1, reused in Tasks 3/4/1's migration script), soft delete (Task 4), scenario_id immutability (Task 4's `PUT` forces `scenario_id` from the URL), create/edit/copy/upload UI (Tasks 5-7), one-level output nesting (validator in Task 1, form's `KeyTypeList` in Task 5), README update (Task 2) — all spec sections have a task.
- **Type consistency:** `ScenarioForm`'s `initial`/return shape (`{ scenario_id, title, dilemma_id, context, goalReal, goalTest, critical_tool, tools, metrics }`) is produced by `emptyScenarioForm()`/`docToFormState()` and consumed identically by `app/scenarios/new/page.js` (Task 5, 7) and `EditScenarioForm.js` (Task 6) — no drift between them. `onSubmit(doc)`'s return contract (`{ ok, errors?, error? }`) matches between `ScenarioForm`'s consumption and both pages' `handleSubmit` implementations.
- **No placeholders:** every step has complete, runnable code — confirmed by re-reading each task's Files/Steps.
