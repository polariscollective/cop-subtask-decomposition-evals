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
