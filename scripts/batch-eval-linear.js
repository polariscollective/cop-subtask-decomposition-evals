#!/usr/bin/env node
// Linear single-style batch runner: for each (model, scenario, style), one
// continuous chain — plan, then execute step 1, 2, 3... in order — using
// the SAME argument style throughout, never switching. Stops at the first
// stage that never gets accepted. One file per chain in runs/, in the
// standard GUI-loadable shape.
//
// Usage:
//   node scripts/batch-eval-linear.js [--batch-id id] [--models m1,m2]
//     [--scenarios s1,s2] [--styles s1,s2,s3] [--max-turns 10] [--budget 15]
//     [--yes] [--dry-run]
//   node scripts/batch-eval-linear.js --report <batch-id>

import fs from "fs";
import readline from "readline";
import { listScenarios, loadScenario } from "../lib/scenarios.js";
import { resolveState, loadState, saveState } from "./batch/linear-state.js";
import { estimateLinearWorstCase } from "./batch/cost.js";
import { printSummaryTable, writeSummaryCsv } from "./batch/linear-report.js";
import { runLinearBatch } from "./batch/linear-run.js";

const DEFAULT_MODELS = ["claude-sonnet-5", "claude-haiku-4-5"];
const DEFAULT_STYLES = ["ethical", "legal", "technical_normalization"];
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
    else if (a === "--styles") args.styles = next().split(",").map((s) => s.trim());
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
  if (!state) throw new Error(`No linear batch found with id "${batchId}" under runs/batches/`);
  printSummaryTable(state);
  console.log(`\nCSV written to ${writeSummaryCsv(state)}`);
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
  const scenarioIds = args.scenarios || listScenarios().map((s) => s.scenario_id);
  const styles = args.styles || DEFAULT_STYLES;
  const maxTurns = args.maxTurns || DEFAULT_MAX_TURNS;
  const batchId = args.batchId || `linear_${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const scenarios = Object.fromEntries(scenarioIds.map((id) => [id, loadScenario(id)]));
  const stepsPerScenario = Object.fromEntries(scenarioIds.map((id) => [id, scenarios[id].tools.length]));

  const { totalUsd, perAttempt } = estimateLinearWorstCase({ models, scenarioIds, styles, maxTurns, stepsPerScenario });

  console.log(`Batch id: ${batchId}`);
  console.log(`Models: ${models.join(", ")}`);
  console.log(`Scenarios: ${scenarioIds.join(", ")}`);
  console.log(`Styles (fixed per chain, never switching): ${styles.join(", ")}`);
  console.log(`Max turns per stage: ${maxTurns}`);
  console.log(`Chains: ${perAttempt.length}`);
  console.log(`\nWorst-case cost estimate (every stage of every chain fully exhausted):`);
  console.log(`  TOTAL: ~$${totalUsd.toFixed(2)}`);
  console.log(`\n(Realistic cost is usually well below this: a chain stops at its first refused stage.)`);

  if (args.dryRun) {
    console.log("\n--dry-run: no model calls made, no state file written.");
    return;
  }

  if (!args.yes) {
    const ok = await confirm("\nProceed with this linear batch?");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const state = await resolveState({ batchId, models, scenarioIds, styles, maxTurns, budgetCap: args.budget });
  await saveState(state);

  await runLinearBatch({ state, scenarios });

  // Reload from disk: state.attempts in memory never carried planResult/
  // steps (only each chain's own local closure did, which is what got
  // written to its run file) — the summary reads the same hydrated shape
  // --report uses, straight off what's actually on disk.
  const finalState = await loadState(batchId);
  console.log("");
  printSummaryTable(finalState);
  console.log(`\nCSV written to ${writeSummaryCsv(finalState)}`);
  console.log(`State file: runs/batches/${batchId}/manifest.json (resume anytime with --batch-id ${batchId})`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
