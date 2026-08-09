# Batch Execution Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a linear/chained batch be launched from a click (eventually in the web dashboard) instead of a laptop CLI command, by adding a Cloud Run Job that runs the existing batch scripts and a small Cloud Run proxy service that the Vercel-hosted app can trigger without a service-account JSON key.

**Architecture:** Vercel app → `POST /api/batch/trigger` → Cloud Run Service `cop-batch-trigger` (shared-secret auth, native GCP identity) → Cloud Run Jobs API → Cloud Run Job `cop-batch-runner` (runs `scripts/batch-eval-linear.js`/`-chained.js`, writes to Supabase exactly like a local run does today).

**Tech Stack:** Docker, Google Cloud Run (Jobs + Services), Terraform (in the separate `polaris-tf` repo), GitHub Actions (WIF-based deploy), Node.js.

**Source spec:** `docs/superpowers/specs/2026-08-09-batch-execution-infra-design.md`.

## Global Constraints

- No service-account JSON keys anywhere (org-wide rule, `polaris-tf/README.md`). All GCP auth is either Workload Identity Federation (CI/CD) or a Cloud Run service's own ambient identity (the proxy calling the Jobs API).
- Pipelines covered: `linear` and `chained` only. Not `base`, not `steps`.
- No hosting migration — the Next.js app stays on Vercel, unchanged.
- No Cloud Tasks queue — the proxy calls the Cloud Run Jobs API directly (see spec's "Alternatives considered").
- `roles/run.developer` (not `roles/run.invoker`) is required on the SA that triggers the job with container overrides — `run.invoker` only covers a plain `run.jobs.run` with no overrides, per the existing lesson already recorded in `polaris-tf/environments/app/cloud_run_job.tf`.
- Terraform resources for this project live in the **existing shared** `environments/app/` codebase in `polaris-tf` (applied to both dev and prod) — not a new Terraform root. This mirrors how every other app resource in that repo already works.
- CI/CD image builds/deploys use `google-github-actions/auth@v2` with `vars.WIF_PROVIDER`/`vars.DEPLOY_SA` (repo variables set once during onboarding), never a key file — copy the exact pattern in `mission-control/.github/workflows/deploy-dev.yml`.
- Terraform job/service resources set `lifecycle { ignore_changes = [...image...] }` on the container image — CI/CD owns the image, Terraform owns everything else (env vars, secrets, IAM).
- This project has no automated test suite. Every task ends with a manual verification (`docker run` locally, `curl`, `gcloud run jobs execute`/`executions describe`, or a Supabase SQL check).

## Repos touched

- **This repo** (`cop-subtask-decomposition-evals`): new `Dockerfile`, `scripts/cloud-run-entrypoint.js`, `services/batch-trigger/`, `app/api/batch/trigger/route.js`, `.env.example`, `.github/workflows/deploy-batch-infra.yml`.
- **`polaris-tf`** (sibling repo at `/Users/sverbo/Desktop/Codes/Polaris/polaris-tf`, absolute paths used throughout since it's outside this repo's working directory): new/modified `.tf` files in `environments/app/`, one line added to `environments/seed/terraform.tfvars`.

## Manual steps a human must do (cannot be automated by an agent)

Flagging these up front since they gate several tasks below:
1. **Seed apply** (Task 6, Step 1): adding this repo to `deploy_github_repos` requires `terraform apply` run locally by an org admin logged in as `admin@polariscollective.org` — `polaris-tf/README.md`'s own documented process, no CI/CD path exists for seed.
2. **Prod approval**: any Terraform change reaching `main` in `polaris-tf` requires GitHub Environment `production` approval per that repo's branch policy — a human clicks approve, an agent cannot.
3. **Setting the shared secret's actual value**: Terraform creates the `BATCH_TRIGGER_SHARED_SECRET` container but never its value (same pattern as every other secret in that repo) — a human runs `gcloud secrets versions add` once, per environment.

---

### Task 1: Cloud Run entrypoint wrapper + Dockerfile for the batch runner

**Files:**
- Create: `scripts/cloud-run-entrypoint.js`
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: the existing `scripts/batch-eval-linear.js` / `scripts/batch-eval-chained.js` CLI entrypoints, unchanged.
- Produces: a Docker image whose `CMD` is this entrypoint, reading job parameters from environment variables (Cloud Run Jobs' container-override mechanism sets env vars, not arbitrary CLI args) and exec'ing the right script with the equivalent flags.

- [ ] **Step 1: Write the entrypoint wrapper**

```js
#!/usr/bin/env node
// Cloud Run Jobs container-override mechanism sets environment variables,
// not arbitrary CLI args — this translates the env vars a trigger sets
// into the same CLI invocation a human would type locally, so
// batch-eval-linear.js/-chained.js need no changes at all to run here.
import { spawn } from "child_process";

const PIPELINE = process.env.PIPELINE;
if (PIPELINE !== "linear" && PIPELINE !== "chained") {
  console.error(`PIPELINE must be "linear" or "chained", got: ${JSON.stringify(PIPELINE)}`);
  process.exit(1);
}

const scriptPath = `scripts/batch-eval-${PIPELINE}.js`;

const args = ["--yes"]; // never interactive in a non-interactive job

function addListFlag(flag, envVar) {
  const value = process.env[envVar];
  if (value) args.push(flag, value);
}

addListFlag("--models", "BATCH_MODELS");
addListFlag("--scenarios", "BATCH_SCENARIOS");
addListFlag("--styles", "BATCH_STYLES");

if (process.env.BATCH_MAX_TURNS) args.push("--max-turns", process.env.BATCH_MAX_TURNS);
if (process.env.BATCH_BUDGET) args.push("--budget", process.env.BATCH_BUDGET);
if (process.env.BATCH_ID) args.push("--batch-id", process.env.BATCH_ID);

if (!process.env.RUN_AUTHOR_EMAIL) {
  console.error("RUN_AUTHOR_EMAIL must be set (the email to attribute these runs to).");
  process.exit(1);
}

console.log(`Running: node ${scriptPath} ${args.join(" ")}`);
const child = spawn("node", [scriptPath, ...args], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
```

- [ ] **Step 2: Write the Dockerfile**

```dockerfile
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib/ ./lib/
COPY scripts/ ./scripts/
COPY scenarios/ ./scenarios/

CMD ["node", "scripts/cloud-run-entrypoint.js"]
```

- [ ] **Step 3: Write `.dockerignore`**

```
node_modules
.next
.git
.env.local
.env
runs
runs_backup_20260807_002806
.superpowers
docs
app
public
```

(Excludes the Next.js app itself, docs, and local run data — the image only needs `lib/`, `scripts/`, `scenarios/`, and production `node_modules`.)

- [ ] **Step 4: Build and test locally**

Run:
```bash
docker build -t cop-batch-runner:local .
```
Expected: builds successfully.

Run (using real local credentials, a tiny scope to keep cost/time low):
```bash
docker run --rm \
  -e PIPELINE=linear \
  -e RUN_AUTHOR_EMAIL=docker-test@example.com \
  -e BATCH_MODELS=claude-haiku-4-5-20251001 \
  -e BATCH_SCENARIOS=single_point_of_command_v0 \
  -e BATCH_STYLES=ethical \
  -e BATCH_MAX_TURNS=3 \
  -e BATCH_BUDGET=1 \
  -e BATCH_ID=docker-local-test \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e SUPABASE_URL="$SUPABASE_URL" \
  -e SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  cop-batch-runner:local
```
Expected: the container runs the linear batch to completion, printing the same turn-by-turn log lines a local `node scripts/batch-eval-linear.js` run does.

Verify via `mcp__supabase__execute_sql`: `select count(*) from runs where batch_id = 'docker-local-test';` returns a row count matching the console output.

- [ ] **Step 5: Commit**

```bash
git add scripts/cloud-run-entrypoint.js Dockerfile .dockerignore
git commit -m "Add Cloud Run entrypoint and Dockerfile for the batch runner"
```

---

### Task 2: Proxy service (`services/batch-trigger/`)

**Files:**
- Create: `services/batch-trigger/package.json`
- Create: `services/batch-trigger/server.js`
- Create: `services/batch-trigger/Dockerfile`

**Interfaces:**
- Consumes: `google-auth-library`'s `GoogleAuth` (same library and pattern as `mission-control/web/lib/cloud-run.ts`) for calling the Cloud Run Jobs `:run` API using the service's own ambient Cloud Run identity.
- Produces: an HTTP server exposing `POST /` (or `/trigger`), accepting `{ pipeline, models, scenarios, styles, maxTurns, budget, batchId, runAuthorEmail }` behind a `Authorization: Bearer <shared secret>` check, returning `{ execution }` (the Cloud Run execution name) on success.

- [ ] **Step 1: `package.json`**

```json
{
  "name": "cop-batch-trigger",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "google-auth-library": "^9.14.0"
  }
}
```

- [ ] **Step 2: `server.js`**

```js
// Minimal HTTP proxy: Vercel can't call the Cloud Run Jobs API directly
// (no GCP identity, and this org never uses service-account JSON keys —
// see polaris-tf/README.md). This service runs ON Cloud Run, so it has a
// native identity for free; Vercel authenticates to *it* with a plain
// shared secret instead.
import http from "node:http";
import { GoogleAuth } from "google-auth-library";

const PORT = process.env.PORT || 8080;
const PROJECT = process.env.GCP_PROJECT;
const REGION = process.env.GCP_REGION;
const JOB_NAME = process.env.BATCH_JOB_NAME || "cop-batch-runner";
const SHARED_SECRET = process.env.BATCH_TRIGGER_SHARED_SECRET;

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

function envOverride(name, value) {
  return { name, value: String(value) };
}

async function triggerBatchJob(params) {
  const envVars = [
    envOverride("PIPELINE", params.pipeline),
    envOverride("RUN_AUTHOR_EMAIL", params.runAuthorEmail),
  ];
  if (params.models?.length) envVars.push(envOverride("BATCH_MODELS", params.models.join(",")));
  if (params.scenarios?.length) envVars.push(envOverride("BATCH_SCENARIOS", params.scenarios.join(",")));
  if (params.styles?.length) envVars.push(envOverride("BATCH_STYLES", params.styles.join(",")));
  if (params.maxTurns != null) envVars.push(envOverride("BATCH_MAX_TURNS", params.maxTurns));
  if (params.budget != null) envVars.push(envOverride("BATCH_BUDGET", params.budget));
  if (params.batchId) envVars.push(envOverride("BATCH_ID", params.batchId));

  const client = await auth.getClient();
  const { token } = await client.getAccessToken();

  const url = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB_NAME}:run`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ overrides: { containerOverrides: [{ env: envVars }] } }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cloud Run Jobs API error ${res.status}: ${text}`);
  }
  const data = await res.json().catch(() => ({}));
  return data?.metadata?.name ?? null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("Method not allowed");
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  if (!SHARED_SECRET || authHeader !== `Bearer ${SHARED_SECRET}`) {
    res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  let params;
  try {
    params = JSON.parse(await readBody(req));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (params.pipeline !== "linear" && params.pipeline !== "chained") {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: 'pipeline must be "linear" or "chained"' })
    );
    return;
  }
  if (!params.runAuthorEmail) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "runAuthorEmail is required" })
    );
    return;
  }

  try {
    const execution = await triggerBatchJob(params);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ execution }));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => console.log(`cop-batch-trigger listening on :${PORT}`));
```

- [ ] **Step 3: `Dockerfile`**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
CMD ["node", "server.js"]
```

- [ ] **Step 4: Test locally**

Run:
```bash
cd services/batch-trigger
npm install
GCP_PROJECT=polaris-dev-499211 GCP_REGION=europe-west1 BATCH_TRIGGER_SHARED_SECRET=test-secret \
  node server.js &
```
Expected: `cop-batch-trigger listening on :8080`.

Run:
```bash
curl -s -X POST http://localhost:8080/ -H "Authorization: Bearer wrong-secret" -d '{}'
```
Expected: `{"error":"unauthorized"}`, HTTP 401.

Run:
```bash
curl -s -X POST http://localhost:8080/ -H "Authorization: Bearer test-secret" -d '{}'
```
Expected: `{"error":"pipeline must be \"linear\" or \"chained\""}`, HTTP 400 (confirms validation runs; the actual Cloud Run Jobs API call can't succeed locally without real GCP credentials and a deployed job — that's covered in Task 6).

Kill the local server (`kill %1` or equivalent) when done.

- [ ] **Step 5: Commit**

```bash
git add services/batch-trigger/
git commit -m "Add Cloud Run proxy service for triggering batch jobs"
```

---

### Task 3: Next.js trigger route

**Files:**
- Create: `app/api/batch/trigger/route.js`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `BATCH_TRIGGER_URL` and `BATCH_TRIGGER_SHARED_SECRET` env vars (new, server-only).
- Produces: `POST /api/batch/trigger` — thin passthrough to the Cloud Run proxy. Auth-gated by the existing `middleware.js` (already protects every route in this app behind the Google-login allowlist) — no new auth logic needed here.

- [ ] **Step 1: Write the route**

```js
import { NextResponse } from "next/server";

export async function POST(req) {
  const body = await req.json();

  const url = process.env.BATCH_TRIGGER_URL;
  const secret = process.env.BATCH_TRIGGER_SHARED_SECRET;
  if (!url || !secret) {
    return NextResponse.json({ error: "BATCH_TRIGGER_URL/BATCH_TRIGGER_SHARED_SECRET not configured" }, { status: 500 });
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
```

- [ ] **Step 2: Add env vars to `.env.example`**

Add, in a new section near the Supabase block:
```
# Batch execution trigger — Cloud Run proxy (see docs/superpowers/specs/2026-08-09-batch-execution-infra-design.md)
BATCH_TRIGGER_URL=
BATCH_TRIGGER_SHARED_SECRET=
```

- [ ] **Step 3: Verify (route logic only — full chain needs Task 6's deployed infra)**

Run: `npm run dev`, then:
```bash
curl -s -X POST http://localhost:3000/api/batch/trigger -d '{}' \
  -H "Cookie: <your session cookie>"
```
Expected (with `BATCH_TRIGGER_URL`/`BATCH_TRIGGER_SHARED_SECRET` unset in `.env.local`): `{"error":"BATCH_TRIGGER_URL/BATCH_TRIGGER_SHARED_SECRET not configured"}`, HTTP 500 — confirms the route is reachable and fails closed rather than silently, before the proxy exists to test against for real.

- [ ] **Step 4: Commit**

```bash
git add app/api/batch/trigger/route.js .env.example
git commit -m "Add Next.js passthrough route for triggering batches"
```

---

### Task 4: Terraform — service accounts, secrets, IAM (`polaris-tf`)

**Files (all in `/Users/sverbo/Desktop/Codes/Polaris/polaris-tf`):**
- Modify: `environments/app/service_accounts.tf`
- Modify: `environments/app/secrets.tf`

**Interfaces:**
- Produces: `google_service_account.cop_batch_trigger`, `google_service_account.cop_batch_runner` (consumed by Task 5's job/service resources), `google_secret_manager_secret.batch_trigger_shared_secret`.

- [ ] **Step 1: Add the two service accounts and their IAM to `service_accounts.tf`**

Append:
```hcl
# --- cop-subtask-decomposition-evals batch execution ---

resource "google_service_account" "cop_batch_trigger" {
  project      = var.project_id
  account_id   = "cop-batch-trigger"
  display_name = "COP Batch Trigger (Vercel-facing proxy)"
}

resource "google_service_account" "cop_batch_runner" {
  project      = var.project_id
  account_id   = "cop-batch-runner"
  display_name = "COP Batch Runner (Cloud Run Job)"
}

# cop-batch-runner reads exactly the secrets it needs — not project-wide.
resource "google_secret_manager_secret_iam_member" "cop_batch_runner_secrets" {
  for_each = {
    anthropic_api_key         = google_secret_manager_secret.anthropic_api_key.secret_id
    supabase_url               = google_secret_manager_secret.cop_supabase_url.secret_id
    supabase_service_role_key  = google_secret_manager_secret.cop_supabase_service_role_key.secret_id
  }

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cop_batch_runner.email}"
}

# cop-batch-trigger reads the shared secret it validates incoming requests against.
resource "google_secret_manager_secret_iam_member" "cop_batch_trigger_secret" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.batch_trigger_shared_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cop_batch_trigger.email}"
}

# Deploy SA needs to act as both new SAs to update their Cloud Run resources.
resource "google_service_account_iam_member" "deploy_github_act_as_cop_batch_trigger" {
  service_account_id = google_service_account.cop_batch_trigger.name
  role                = "roles/iam.serviceAccountUser"
  member              = "serviceAccount:github-actions-deploy@${var.seed_project_id}.iam.gserviceaccount.com"
}

resource "google_service_account_iam_member" "deploy_github_act_as_cop_batch_runner" {
  service_account_id = google_service_account.cop_batch_runner.name
  role                = "roles/iam.serviceAccountUser"
  member              = "serviceAccount:github-actions-deploy@${var.seed_project_id}.iam.gserviceaccount.com"
}
```

Note: `google_secret_manager_secret.anthropic_api_key` already exists (defined in this same file's neighbor, `secrets.tf`) — reused as-is, not duplicated. `cop_supabase_url`/`cop_supabase_service_role_key` are created in Step 2 below.

- [ ] **Step 2: Add the three new secrets to `secrets.tf`**

Append:
```hcl
# --- cop-subtask-decomposition-evals batch execution ---

resource "google_secret_manager_secret" "cop_supabase_url" {
  project   = var.project_id
  secret_id = "COP_SUPABASE_URL"
  labels    = { service = "cop-batch-runner" }
  replication {
    auto {}
  }
  depends_on = [module.app_apis]
  # No initial value — set manually: gcloud secrets versions add COP_SUPABASE_URL --data-file=- --project=PROJECT_ID
}

resource "google_secret_manager_secret" "cop_supabase_service_role_key" {
  project   = var.project_id
  secret_id = "COP_SUPABASE_SERVICE_ROLE_KEY"
  labels    = { service = "cop-batch-runner" }
  replication {
    auto {}
  }
  depends_on = [module.app_apis]
  # No initial value — set manually: gcloud secrets versions add COP_SUPABASE_SERVICE_ROLE_KEY --data-file=- --project=PROJECT_ID
}

# Validated by services/batch-trigger/server.js against the incoming
# Authorization header. Same value set as a Vercel project env var
# (BATCH_TRIGGER_SHARED_SECRET) — generate with: openssl rand -base64 32
resource "google_secret_manager_secret" "batch_trigger_shared_secret" {
  project   = var.project_id
  secret_id = "BATCH_TRIGGER_SHARED_SECRET"
  labels    = { service = "cop-batch-trigger" }
  replication {
    auto {}
  }
  depends_on = [module.app_apis]
}
```

Note: `COP_` prefix on the two Supabase secrets distinguishes them from any other app's same-named secret in this shared project (`ANTHROPIC_API_KEY` is intentionally reused unprefixed since it's the same literal key mission-control already reads — Anthropic API keys aren't app-scoped).

- [ ] **Step 3: Verify with `terraform plan`**

Run (from `polaris-tf`):
```bash
cd environments/app
terraform init
terraform plan -var-file=terraform.tfvars.dev
```
Expected: plan shows 2 new service accounts, 3 new secrets, 6 new IAM bindings to be created — no errors, no unexpected changes to existing resources (mission-control's resources should show zero diff).

- [ ] **Step 4: Commit (in `polaris-tf`)**

```bash
cd /Users/sverbo/Desktop/Codes/Polaris/polaris-tf
git add environments/app/service_accounts.tf environments/app/secrets.tf
git commit -m "Add service accounts and secrets for cop-subtask-decomposition-evals batch execution"
```

Do NOT push or open a PR yet — Task 6 adds the remaining resources first, then everything ships together.

---

### Task 5: Terraform — Cloud Run Job and Service (`polaris-tf`)

**Files (in `/Users/sverbo/Desktop/Codes/Polaris/polaris-tf`):**
- Create: `environments/app/cop_batch.tf`

**Interfaces:**
- Consumes: `google_service_account.cop_batch_trigger`, `google_service_account.cop_batch_runner`, the three secrets from Task 4.
- Produces: `google_cloud_run_v2_job.cop_batch_runner`, `google_cloud_run_v2_service.cop_batch_trigger`.

- [ ] **Step 1: Write `environments/app/cop_batch.tf`**

```hcl
# ---------------------------------------------------------------------------
# cop-subtask-decomposition-evals — batch execution (Cloud Run Job + trigger proxy)
# See: docs/superpowers/specs/2026-08-09-batch-execution-infra-design.md
# in the cop-subtask-decomposition-evals repo.
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_job" "cop_batch_runner" {
  project  = var.project_id
  name     = "cop-batch-runner"
  location = var.region

  template {
    template {
      service_account = google_service_account.cop_batch_runner.email
      max_retries     = 0
      timeout         = "3600s"

      containers {
        # Placeholder image — CI/CD updates this on each deploy.
        image = "us-docker.pkg.dev/cloudrun/container/hello"

        env {
          name = "ANTHROPIC_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.anthropic_api_key.secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "SUPABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.cop_supabase_url.secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "SUPABASE_SERVICE_ROLE_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.cop_supabase_service_role_key.secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
    ]
  }

  depends_on = [module.app_apis]
}

# cop-batch-trigger can run this job WITH env var overrides (per-request
# model/scenario/style choices). roles/run.invoker alone only covers a
# plain run.jobs.run with no overrides — see the same lesson already
# recorded on the automation job resource above.
resource "google_cloud_run_v2_job_iam_member" "cop_batch_runner_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.cop_batch_runner.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.cop_batch_trigger.email}"
}

resource "google_cloud_run_v2_service" "cop_batch_trigger" {
  project  = var.project_id
  name     = "cop-batch-trigger"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.cop_batch_trigger.email

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      # Placeholder image — CI/CD updates this on each deploy.
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "BATCH_JOB_NAME"
        value = google_cloud_run_v2_job.cop_batch_runner.name
      }
      env {
        name = "BATCH_TRIGGER_SHARED_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.batch_trigger_shared_secret.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
    ]
  }

  depends_on = [module.app_apis]
}

# Publicly reachable (Vercel calls it over the internet) — auth is the
# shared-secret check inside the app itself, same pattern as
# mission-control's own public ingress + app-level Google-login check.
resource "google_cloud_run_v2_service_iam_member" "cop_batch_trigger_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.cop_batch_trigger.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
```

- [ ] **Step 2: Verify with `terraform plan`**

Run:
```bash
cd /Users/sverbo/Desktop/Codes/Polaris/polaris-tf/environments/app
terraform plan -var-file=terraform.tfvars.dev
```
Expected: plan shows the new job, the new service, and 2 new IAM bindings to be created — still zero diff on existing resources.

- [ ] **Step 3: Commit**

```bash
git add environments/app/cop_batch.tf
git commit -m "Add Cloud Run Job and trigger-proxy Service for cop-subtask-decomposition-evals"
```

---

### Task 6: Onboarding, deploy, and end-to-end verification

**Files:**
- Modify (in `polaris-tf`): `environments/seed/terraform.tfvars`
- Create (in this repo): `.github/workflows/deploy-batch-infra.yml`

**Interfaces:** None new — this task wires together everything from Tasks 1–5 and proves the whole chain works against real dev infrastructure.

- [ ] **Step 1: Onboard this repo in seed (MANUAL — human with admin access)**

In `polaris-tf/environments/seed/terraform.tfvars`, change:
```hcl
deploy_github_repos = ["mission-control"]
```
to:
```hcl
deploy_github_repos = ["mission-control", "cop-subtask-decomposition-evals"]
```
Then, as `admin@polariscollective.org`:
```bash
gcloud auth login admin@polariscollective.org
cd polaris-tf/environments/seed
terraform apply
```
Expected: applies cleanly, outputs unchanged `workload_identity_provider`/`deploy_sa_email` (the repo list is additive, doesn't rotate anything).

- [ ] **Step 2: Set GitHub Actions variables on this repo (MANUAL)**

In this repo's GitHub settings (`Settings > Variables > Actions`), set:
- `WIF_PROVIDER` — from `terraform output workload_identity_provider` (seed)
- `DEPLOY_SA` — from `terraform output deploy_sa_email` (seed)

- [ ] **Step 3: Write the deploy workflow**

```yaml
name: Deploy Batch Infra

on:
  push:
    branches: [main]
    paths: ["Dockerfile", "scripts/**", "lib/**", "scenarios/**", "services/batch-trigger/**"]

env:
  REGION: europe-west1
  PROJECT: polaris-prod-499213
  REGISTRY: europe-west1-docker.pkg.dev/genial-broker-499211-s1/polaris-docker

jobs:
  deploy-runner:
    name: Build & Deploy Batch Runner Job
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER }}
          service_account: ${{ vars.DEPLOY_SA }}
      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet
      - uses: docker/setup-buildx-action@v3
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ${{ env.REGISTRY }}/cop-batch-runner:${{ github.sha }}
            ${{ env.REGISTRY }}/cop-batch-runner:latest
      - name: Deploy to Cloud Run Job
        run: |
          gcloud run jobs update cop-batch-runner \
            --image=${{ env.REGISTRY }}/cop-batch-runner:${{ github.sha }} \
            --region=${{ env.REGION }} \
            --project=${{ env.PROJECT }}

  deploy-trigger:
    name: Build & Deploy Trigger Proxy
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER }}
          service_account: ${{ vars.DEPLOY_SA }}
      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet
      - uses: docker/setup-buildx-action@v3
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ./services/batch-trigger
          push: true
          tags: |
            ${{ env.REGISTRY }}/cop-batch-trigger:${{ github.sha }}
            ${{ env.REGISTRY }}/cop-batch-trigger:latest
      - name: Deploy to Cloud Run Service
        run: |
          gcloud run services update cop-batch-trigger \
            --image=${{ env.REGISTRY }}/cop-batch-trigger:${{ github.sha }} \
            --region=${{ env.REGION }} \
            --project=${{ env.PROJECT }}
```

Note: this workflow only triggers on `main` (prod) — there's no `develop` branch or dev deploy path for *this* repo today (it deploys to Vercel directly on every push, unlike mission-control). Trigger the very first deploy manually instead (Step 4) so Tasks 4–5's dev-environment `terraform plan` can be verified against a real running job before anything reaches prod.

- [ ] **Step 4: First manual deploy to dev, to verify before prod**

Apply Tasks 4–5's Terraform to dev, then build/push/deploy manually once:
```bash
cd polaris-tf/environments/app
terraform apply -var-file=terraform.tfvars.dev

cd /Users/sverbo/Desktop/Codes/Polaris/cop-subtask-decomposition-evals
gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet
docker build -t europe-west1-docker.pkg.dev/genial-broker-499211-s1/polaris-docker/cop-batch-runner:dev-manual .
docker push europe-west1-docker.pkg.dev/genial-broker-499211-s1/polaris-docker/cop-batch-runner:dev-manual
gcloud run jobs update cop-batch-runner --image=europe-west1-docker.pkg.dev/genial-broker-499211-s1/polaris-docker/cop-batch-runner:dev-manual --region=europe-west1 --project=polaris-dev-499211

cd services/batch-trigger
docker build -t europe-west1-docker.pkg.dev/genial-broker-499211-s1/polaris-docker/cop-batch-trigger:dev-manual .
docker push europe-west1-docker.pkg.dev/genial-broker-499211-s1/polaris-docker/cop-batch-trigger:dev-manual
gcloud run services update cop-batch-trigger --image=europe-west1-docker.pkg.dev/genial-broker-499211-s1/polaris-docker/cop-batch-trigger:dev-manual --region=europe-west1 --project=polaris-dev-499213
```

- [ ] **Step 5: Set the shared secret and Supabase secret values (MANUAL, dev)**

```bash
openssl rand -base64 32 | gcloud secrets versions add BATCH_TRIGGER_SHARED_SECRET --data-file=- --project=polaris-dev-499211
echo -n "https://hkqzamibfpyvlowiqgpn.supabase.co" | gcloud secrets versions add COP_SUPABASE_URL --data-file=- --project=polaris-dev-499211
echo -n "<the real service role key>" | gcloud secrets versions add COP_SUPABASE_SERVICE_ROLE_KEY --data-file=- --project=polaris-dev-499211
```
Keep the generated shared-secret value — it's needed for Step 6.

- [ ] **Step 6: End-to-end curl test against dev**

```bash
TRIGGER_URL=$(gcloud run services describe cop-batch-trigger --region=europe-west1 --project=polaris-dev-499211 --format='value(status.url)')
curl -s -X POST "$TRIGGER_URL/" \
  -H "Authorization: Bearer <the secret from Step 5>" \
  -H "Content-Type: application/json" \
  -d '{"pipeline":"linear","models":["claude-haiku-4-5-20251001"],"scenarios":["single_point_of_command_v0"],"styles":["ethical"],"maxTurns":3,"budget":1,"batchId":"cloud-run-e2e-test","runAuthorEmail":"e2e-test@example.com"}'
```
Expected: `{"execution":"projects/.../executions/cop-batch-runner-..."}`, HTTP 200.

Run: `gcloud run jobs executions describe <execution-name-from-above> --region=europe-west1 --project=polaris-dev-499211`
Expected: eventually shows `succeeded` (poll every ~30s — a small batch like this takes a few minutes).

Verify via `mcp__supabase__execute_sql`: `select count(*) from runs where batch_id = 'cloud-run-e2e-test';` — matches the batch's expected row count, confirming the whole chain (curl → proxy → Jobs API → job → Supabase) works end-to-end with zero local involvement beyond the curl command itself.

- [ ] **Step 7: Set Vercel env vars (MANUAL)**

In the Vercel project settings, add (server-only, no `NEXT_PUBLIC_` prefix):
- `BATCH_TRIGGER_URL` = the dev (then later, prod) Cloud Run service URL
- `BATCH_TRIGGER_SHARED_SECRET` = the same value set in Step 5

- [ ] **Step 8: Commit the workflow, open the `polaris-tf` PR**

```bash
cd /Users/sverbo/Desktop/Codes/Polaris/cop-subtask-decomposition-evals
git add .github/workflows/deploy-batch-infra.yml
git commit -m "Add CI/CD workflow to build and deploy batch execution infra"
```

```bash
cd /Users/sverbo/Desktop/Codes/Polaris/polaris-tf
git push -u origin <branch>
gh pr create --title "Add cop-subtask-decomposition-evals batch execution infra" --body "Cloud Run Job + trigger proxy for launching linear/chained batches from the web app. See cop-subtask-decomposition-evals docs/superpowers/specs/2026-08-09-batch-execution-infra-design.md."
```
This PR triggers `terraform-plan.yml` on both dev and prod automatically. Merging to `develop` applies dev (already manually applied in Step 4, so this reconciles Terraform state with what's already running); merging to `main` requires the `production` environment approval (**MANUAL** — a human clicks approve) before applying prod.
