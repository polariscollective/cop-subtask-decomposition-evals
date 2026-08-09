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
