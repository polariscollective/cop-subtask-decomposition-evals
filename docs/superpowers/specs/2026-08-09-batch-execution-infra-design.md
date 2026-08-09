# Batch execution infrastructure — design

## Purpose

Today, running a batch (`scripts/batch-eval-linear.js` / `-chained.js`) means SSHing into a
laptop and typing a CLI command. The goal of this project is to let a batch be launched from
the web dashboard instead — click a button, the batch runs somewhere real, its progress and
results land in Supabase exactly like a locally-run batch already does.

This is sub-project 1 of 2: **execution infrastructure only** — a Cloud Run Job that can run a
linear/chained batch, and a way to trigger it from the Vercel-hosted app without a JSON key.
Sub-project 2 (a separate spec, later) is the actual web UI form for choosing scenarios,
models, styles, and watching progress.

## Scope

- **Pipelines covered:** linear and chained only. The base (plan+execute) and steps (multi-style
  branching) pipelines are explicitly out of scope — the user doesn't use them and doesn't want
  the added complexity of building a launcher for them right now.
- **Hosting:** the Next.js app stays on Vercel. No hosting migration. A full move to Cloud Run
  was considered and explicitly deferred — see "Alternatives considered" below.
- **Trigger:** manual only (a button click). No cron/scheduling in this phase.

## Why this needs new infrastructure, not just an API route

A batch run takes minutes to tens of minutes (many model calls, real API spend). A Vercel
serverless function can't hold a request open that long. The batch needs to actually execute
somewhere that isn't tied to the HTTP request that started it — a real async job.

## Architecture

```
Vercel (existing Next.js app, unchanged hosting)
  │
  │  POST /api/batch/trigger  (new Next.js API route)
  │  Authorization: Bearer <shared secret>
  │  body: { pipeline, models, scenarios, styles, maxTurns, budget, batchId, runAuthorEmail }
  ▼
Cloud Run Service "cop-batch-trigger"  (new, tiny proxy — native GCP identity, no key)
  │  validates the shared secret
  │  calls Cloud Run Jobs API using its own service identity
  ▼
POST https://run.googleapis.com/v2/projects/{project}/locations/{region}/jobs/cop-batch-runner:run
  │  { overrides: { containerOverrides: [{ env: [...] }] } }
  ▼
Cloud Run Job "cop-batch-runner"  (new)
  │  runs scripts/batch-eval-linear.js or -chained.js, selected by PIPELINE env var
  │  writes progress/results directly to Supabase (runs/batches tables) — same code path,
  │  same lib/supabase.js, as a batch run from a laptop today
  ▼
Supabase (already in place — no changes here)
```

Why a proxy service instead of calling the Cloud Run Jobs API directly from the Vercel API
route: Vercel has no native GCP identity. The two ways around that are a service-account JSON
key (against this org's "no JSON keys anywhere" rule, stated in `polaris-tf/README.md`) or
untested Vercel→GCP OIDC federation. The proxy sidesteps both — it's a normal Cloud Run
service with the same built-in identity every other Cloud Run service in this org already has
(see `mission-control/web/lib/cloud-run.ts` for the exact pattern this copies), and Vercel
authenticates to *it* with a plain shared secret over HTTPS, no GCP-specific auth involved.

## Components

### 1. `cop-batch-runner` — Cloud Run Job

- **Image:** built from this repo (`cop-subtask-decomposition-evals`) via a new `Dockerfile`
  at the repo root (no existing Dockerfile in this repo today — confirmed clean), pushed to the
  shared Artifact Registry (`polaris-docker`, per `polaris-tf`'s seed), tagged
  `cop-batch-runner:latest`.
- **Contents:** the whole repo (`scripts/`, `lib/`, `scenarios/`, production `node_modules`) —
  same code that runs locally, no fork/duplication.
- **Entrypoint:** a new small wrapper, `scripts/cloud-run-entrypoint.js`, that reads job
  parameters from environment variables (Cloud Run Jobs' container-override mechanism sets env
  vars, not arbitrary CLI args) and execs the right script with the right flags:
  - `PIPELINE` (`linear` | `chained`) → selects `batch-eval-linear.js` vs `batch-eval-chained.js`
  - `BATCH_MODELS`, `BATCH_SCENARIOS`, `BATCH_STYLES` (comma-separated) → `--models`,
    `--scenarios`, `--styles`
  - `BATCH_MAX_TURNS`, `BATCH_BUDGET` → `--max-turns`, `--budget`
  - `BATCH_ID` → `--batch-id`
  - `RUN_AUTHOR_EMAIL` → passed through unchanged (already a required env var for these scripts)
  - Always appends `--yes` (no interactive confirmation prompt in a non-interactive job)
- **Secrets (Secret Manager, mounted as env vars):** `ANTHROPIC_API_KEY`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — same names, same values already used locally,
  just sourced from Secret Manager instead of `.env.local`. No provider keys beyond Anthropic
  are needed since linear/chained batches only ever use Anthropic models today (per
  `DEFAULT_MODELS` in both scripts).
- **Resource limits / timeout:** generous — Cloud Run Jobs support up to 24h task timeout, no
  need to tune this tightly at launch; a `--budget` cap already bounds real-world runtime and
  spend. Concurrency: 1 task per execution (a batch is inherently sequential across its own
  attempts, per `runLinearBatch`/`runChainedBatch`'s for-loop).

### 2. `cop-batch-trigger` — Cloud Run Service (proxy)

- **Separate, minimal codebase** — not part of the Next.js app. New directory in this repo,
  `services/batch-trigger/` (plain Node, no framework needed: `http.createServer` or a
  one-file Express app), with its own small `Dockerfile`. Kept separate from the batch-runner
  image on purpose — this service's whole job is "receive one HTTP request, make one HTTP
  request," it doesn't need the batch pipeline's dependencies (Anthropic SDK, scenario YAML,
  etc.) at all, so bundling it into the same image would mean a bigger, slower-to-cold-start
  image for no benefit.
- **Auth:** validates `Authorization: Bearer <shared secret>` against a secret it reads from
  Secret Manager (`BATCH_TRIGGER_SHARED_SECRET`). The same value is set as a Vercel project
  environment variable (server-only, no `NEXT_PUBLIC_` prefix, matching every other secret in
  this app). Generated once (`openssl rand -base64 32`), rotated the same manual way
  `ANTHROPIC_API_KEY` already is per `polaris-tf/README.md`'s "Managing secret values" section.
- **Body it accepts:** `{ pipeline, models, scenarios, styles, maxTurns, budget, batchId,
  runAuthorEmail }` — validates `pipeline` is `"linear"` or `"chained"` and required fields are
  present, then translates directly into the Cloud Run Jobs `:run` container-override env vars
  listed above (the exact translation `cloud-run.ts` in mission-control already does for its
  own job, adapted to this job's specific env var names) and calls the Jobs API using
  `google-auth-library`'s `GoogleAuth` with the service's own ambient credentials (identical
  library and pattern to mission-control — no new approach to validate).
- **Response:** the Cloud Run execution name/ID on success (so the caller can log it), or a
  clear error with the Jobs API's own status code/message on failure. No dual-write fallback —
  if the Jobs API call fails, the error surfaces, nothing is silently retried or swallowed.

### 3. `POST /api/batch/trigger` — new Next.js API route (this repo, Vercel)

Thin passthrough, not business logic: reads the request body, adds the shared-secret header,
forwards to the proxy's URL (`BATCH_TRIGGER_URL`, a new env var pointing at the Cloud Run
proxy service), returns the proxy's response. Auth-gated the same way every other route in this
app already is (existing `middleware.js` + Google-login allowlist) — being signed into the
dashboard is what authorizes triggering a batch, the shared secret is purely for the
Vercel→GCP hop, not end-user auth.

This route exists in *this* sub-project (not sub-project 2) specifically so the whole chain —
UI-less, curl-tested — can be verified end-to-end before any form is built: `curl -X POST
.../api/batch/trigger -d '{"pipeline":"linear","scenarios":["..."],...}'` should produce a real
running batch with real rows appearing in Supabase.

### 4. IAM / Terraform (in the separate `polaris-tf` repo)

New files in `environments/app/` (applied to both dev and prod, per that repo's existing
pattern), plus one addition in `environments/seed/`:

- **`environments/seed/terraform.tfvars`:** add `"cop-subtask-decomposition-evals"` to
  `deploy_github_repos` — onboards this repo for WIF-based CI/CD deploy access, the same step
  every existing app repo went through (`polaris-tf/README.md`'s "Giving a new GitHub repo
  deploy access").
- **`environments/app/service_accounts.tf`:** two new service accounts —
  - `cop-batch-trigger@<project>.iam.gserviceaccount.com` — `roles/run.invoker` on the
    `cop-batch-runner` job only (least privilege: it can start that one job, nothing else).
  - `cop-batch-runner@<project>.iam.gserviceaccount.com` — `roles/secretmanager.secretAccessor`
    on exactly the three secrets it needs (`ANTHROPIC_API_KEY`, `SUPABASE_URL`,
    `SUPABASE_SERVICE_ROLE_KEY`), not project-wide access.
- **`environments/app/cloud_run.tf`:** the `cop-batch-runner` Cloud Run Job resource and the
  `cop-batch-trigger` Cloud Run Service resource (min instances 0 — scale to zero, this is
  triggered rarely; max instances 1, since it's a single-purpose relay with no need for
  concurrency).
- **`environments/app/secrets.tf`:** add the `BATCH_TRIGGER_SHARED_SECRET` container (value set
  manually per the existing "Managing secret values" process, never by Terraform).
- **New GitHub Actions workflow in *this* repo** (`.github/workflows/deploy-batch-infra.yml`,
  following the pattern other app repos use): builds and pushes both Docker images
  (`cop-batch-runner`, `cop-batch-trigger`) to Artifact Registry, then updates the Cloud Run
  Job/Service to the new image, on push to `develop`/`main` — reusing the shared
  `github-actions-deploy` SA and `WIF_PROVIDER`/`DEPLOY_SA` repo variables set up during
  onboarding.

### 5. Status / progress tracking

No new work. The Cloud Run Job runs the exact same `scripts/batch-eval-linear.js` /
`-chained.js` code that already writes to Supabase's `runs` and `batches` tables via
`lib/supabase.js`, incrementally, after every turn — this is exactly what the Supabase
migration (see `docs/superpowers/specs/2026-08-09-supabase-runs-migration-design.md`) already
built and verified with real batch runs. Sub-project 2's UI reads this via Supabase directly
(ideally Supabase Realtime, subscribing to `batches` row changes, rather than polling) — that's
its own concern, not something this infra project needs to prepare beyond "the data is already
there, live, in Postgres" (which it already is).

## Data flow for one triggered batch

1. User clicks "Run batch" in the dashboard (sub-project 2, not built yet) → `POST
   /api/batch/trigger` with the chosen parameters.
2. Vercel route forwards to `cop-batch-trigger` with the shared secret.
3. Proxy validates the secret, calls Cloud Run Jobs `:run` with env var overrides.
4. `cop-batch-runner` starts, `scripts/cloud-run-entrypoint.js` execs
   `batch-eval-linear.js`/`-chained.js` with the equivalent CLI flags.
5. The script runs exactly as it does locally: resolves/creates batch state in Supabase's
   `batches` table, writes each attempt as a row in `runs`, updates `batches.data` after every
   turn.
6. Job finishes (or hits its `--budget` cap and stops cleanly, same as today); Cloud Run marks
   the execution complete. Supabase already reflects the final state — nothing further to do.

## Alternatives considered

**Migrate the whole app from Vercel to Cloud Run**, so the app itself has native GCP identity
and can call the Cloud Run Jobs API directly, no proxy needed. Rejected for *this* project: it's
a materially larger, separate undertaking (Google OAuth redirect URI changes, env vars moving
to Secret Manager, new CI/CD, custom domain/HTTPS setup) with a much bigger blast radius if
something breaks (the whole app's availability, not just "a batch didn't start"). The proxy
approach solves the actual problem (trigger a job from Vercel without a JSON key) with far less
surface area, and nothing built here is wasted if a full hosting migration happens later — the
Docker image, Terraform patterns, and IAM setup all carry over; the only thing that would
eventually disappear is the proxy service itself, once the main app can call Cloud Run Jobs
directly.

**Cloud Tasks queue in front of the job** (mission-control's pattern for its cron+manual
paths). Not included here: mission-control uses Cloud Tasks for retry/backoff and to cap
concurrent dispatches across many different scheduled automations. This project has exactly one
manual trigger path and no scheduling, so a queue adds operational surface (a new resource, new
IAM, retry semantics to reason about) without a concrete need it solves yet. Calling the Jobs
API directly, as the proxy does, is the same thing mission-control's own "Run now" button does
for a manual trigger — Cloud Tasks in that architecture is specifically for the *cron* path,
which doesn't exist here. Can be added later if concurrent-trigger volume ever becomes a real
problem.

## Out of scope

- The web UI form for choosing scenarios/models/styles and watching progress (sub-project 2).
- Cron/scheduled batches.
- The base and steps pipelines.
- Migrating the Next.js app's hosting off Vercel.
- Cost/budget guardrails beyond the existing per-batch `--budget` flag (e.g. a global spend cap
  across concurrent triggered batches) — not needed at today's usage (manual, occasional
  triggers), worth revisiting if usage grows.

## Testing plan

Manual, matching this project's existing practice (no automated suite):
1. Build and deploy both images locally against the dev GCP project; confirm
   `gcloud run jobs execute cop-batch-runner` with manual env var overrides runs a real batch
   and writes rows to Supabase (bypassing the proxy, to isolate the job itself first).
2. Deploy the proxy; `curl` it directly with a valid and then an invalid shared secret, confirm
   it accepts/rejects correctly and that a valid call actually starts the job (cross-check via
   `gcloud run jobs executions list`).
3. Deploy `/api/batch/trigger` to a Vercel preview; `curl` *that* end-to-end with the dashboard's
   session cookie, confirm a real batch starts and Supabase rows appear, matching what a local
   CLI run of the same parameters would produce.
4. Confirm a deliberately-wrong shared secret is rejected all the way through (proxy returns
   401, Vercel route surfaces that, no job starts).
