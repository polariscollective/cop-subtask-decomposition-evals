#!/usr/bin/env node
// Batch eval runner: automates the planning-stage subtask-decomposition
// eval (equivalent to POST /api/plan) across a matrix of
// model x scenario x framing x argument-style, sequentially, with a
// resumable state file and a budget cap.
//
// Usage:
//   node scripts/batch-eval.js [--batch-id id] [--models m1,m2]
//     [--scenarios s1,s2] [--max-turns 10] [--budget 15] [--yes] [--dry-run]
//   node scripts/batch-eval.js --report <batch-id>
//
// See docs/superpowers/specs/2026-08-05-batch-eval-design.md for the design.

import fs from "fs";
import readline from "readline";
import { listScenarios, loadScenario } from "../lib/scenarios.js";
import { resolveState, loadState, saveState } from "./batch/state.js";
import { estimateWorstCase } from "./batch/cost.js";
import { printSummaryTable, writeSummaryCsv } from "./batch/report.js";
import { runBatch } from "./batch/run.js";

const DEFAULT_MODELS = ["claude-opus-5", "claude-haiku-4-5"];
const DEFAULT_MAX_TURNS = 10;

function loadEnvLocalOverriding(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = { yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--batch-id") args.batchId = next();
    else if (a === "--models") args.models = next().split(",").map((s) => s.trim());
    else if (a === "--scenarios") args.scenarios = next().split(",").map((s) => s.trim());
    else if (a === "--max-turns") args.maxTurns = Number(next());
    else if (a === "--budget") args.budget = Number(next());
    else if (a === "--yes") args.yes = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--report") args.report = next();
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function runReport(batchId) {
  const state = await loadState(batchId);
  if (!state) throw new Error(`No batch found with id "${batchId}" under runs/batches/`);
  printSummaryTable(state);
  const csvPath = writeSummaryCsv(state);
  console.log(`\nCSV written to ${csvPath}`);
}

async function main() {
  // process.loadEnvFile only fills in vars that aren't already set — it
  // won't override an ANTHROPIC_API_KEY inherited from the shell, which
  // would silently use the wrong key if the shell's differs from
  // .env.local's. Parse .env.local ourselves and force its values in.
  loadEnvLocalOverriding(".env.local");

  if (!process.env.RUN_AUTHOR_EMAIL) {
    console.error(
      "RUN_AUTHOR_EMAIL must be set (the email to attribute these runs to). " +
        "Add it to .env.local or export it before running this script."
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));

  if (args.report) {
    await runReport(args.report);
    return;
  }

  const models = args.models || DEFAULT_MODELS;
  const scenarioIds = args.scenarios || (await listScenarios()).map((s) => s.scenario_id);
  const maxTurns = args.maxTurns || DEFAULT_MAX_TURNS;
  const batchId =
    args.batchId || `batch_${new Date().toISOString().replace(/[:.]/g, "-")}`;

  if (!models.every((m) => m)) throw new Error("--models must be a non-empty comma-separated list");
  if (scenarioIds.length === 0) throw new Error("No scenarios found (or --scenarios resolved to none)");

  const { totalUsd, perCombo } = estimateWorstCase({ models, scenarioIds, maxTurns });

  console.log(`Batch id: ${batchId}`);
  console.log(`Models: ${models.join(", ")}`);
  console.log(`Scenarios: ${scenarioIds.join(", ")}`);
  console.log(`Max turns per attempt: ${maxTurns}`);
  console.log(`\nWorst-case cost estimate (nothing ever accepted, both framings fully exhausted):`);
  for (const c of perCombo) {
    console.log(`  ${c.model} x ${c.scenarioId}: ~$${c.cost.toFixed(2)}`);
  }
  console.log(`  TOTAL: ~$${totalUsd.toFixed(2)}`);
  console.log(
    `\n(Realistic cost is usually well below this: any style that succeeds under "real" ` +
      `skips the "test" framing entirely, and shortens whichever branch accepted early.)`
  );

  if (args.dryRun) {
    console.log("\n--dry-run: no model calls made, no state file written.");
    return;
  }

  if (!args.yes) {
    const ok = await confirm("\nProceed with this batch?");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const state = await resolveState({ batchId, models, scenarioIds, maxTurns, budgetCap: args.budget });
  await saveState(state);

  const scenarios = Object.fromEntries(
    await Promise.all(scenarioIds.map(async (id) => [id, await loadScenario(id)]))
  );

  await runBatch({ state, scenarios });

  console.log("");
  printSummaryTable(state);
  const csvPath = writeSummaryCsv(state);
  console.log(`\nCSV written to ${csvPath}`);
  console.log(`State file: runs/batches/${batchId}/state.json (resume anytime with --batch-id ${batchId})`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
