#!/usr/bin/env node
// Chained batch runner: one continuous conversation per (model, scenario,
// style) — the model has all of the scenario's tools directly from the
// start (no separate plan) and is pushed, one fixed style throughout, to
// call each tool in sequence, seeing each tool's (fabricated) result
// before deciding the next call. Contrast with scripts/batch-eval-linear.js,
// which uses the blind, amnesiac per-step executor instead.
//
// Usage:
//   node scripts/batch-eval-chained.js [--batch-id id] [--models m1,m2]
//     [--scenarios s1,s2] [--styles s1,s2,s3] [--max-turns 10] [--budget 15]
//     [--yes] [--dry-run]
//   node scripts/batch-eval-chained.js --report <batch-id>

import fs from "fs";
import readline from "readline";
import { listScenarios, loadScenario } from "../lib/scenarios.js";
import { resolveState, loadState, saveState } from "./batch/chained-state.js";
import { estimateChainedWorstCase } from "./batch/cost.js";
import { printSummaryTable, writeSummaryCsv } from "./batch/chained-report.js";
import { runChainedBatch } from "./batch/chained-run.js";

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
  if (!state) throw new Error(`No chained batch found with id "${batchId}" under runs/batches/`);
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
  const scenarioIds = args.scenarios || (await listScenarios()).map((s) => s.scenario_id);
  const styles = args.styles || DEFAULT_STYLES;
  const maxTurns = args.maxTurns || DEFAULT_MAX_TURNS;
  const batchId = args.batchId || `chained_${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const scenarios = Object.fromEntries(
    await Promise.all(scenarioIds.map(async (id) => [id, await loadScenario(id)]))
  );
  const toolsPerScenario = Object.fromEntries(scenarioIds.map((id) => [id, scenarios[id].tools.length]));

  const { totalUsd, perAttempt } = estimateChainedWorstCase({ models, scenarioIds, styles, maxTurns, toolsPerScenario });

  console.log(`Batch id: ${batchId}`);
  console.log(`Models: ${models.join(", ")}`);
  console.log(`Scenarios: ${scenarioIds.join(", ")}`);
  console.log(`Styles (fixed per conversation, never switching): ${styles.join(", ")}`);
  console.log(`Max turns per tool-slot: ${maxTurns}`);
  console.log(`Conversations: ${perAttempt.length}`);
  console.log(`\nWorst-case cost estimate (every tool-slot fully exhausted):`);
  console.log(`  TOTAL: ~$${totalUsd.toFixed(2)}`);
  console.log(`\n(Realistic cost is usually well below this: a conversation stops at the first tool it won't call.)`);

  if (args.dryRun) {
    console.log("\n--dry-run: no model calls made, no state file written.");
    return;
  }

  if (!args.yes) {
    const ok = await confirm("\nProceed with this chained batch?");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const state = await resolveState({ batchId, models, scenarioIds, styles, maxTurns, budgetCap: args.budget });
  await saveState(state);

  await runChainedBatch({ state, scenarios });

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
