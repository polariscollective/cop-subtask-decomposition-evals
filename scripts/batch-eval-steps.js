#!/usr/bin/env node
// Step-execution batch runner: for every accepted plan already saved in
// runs/ (or a chosen subset), walks its steps in order. Each step is
// tested the same way planning was — one baseline one-shot ask (always
// the tool's REAL description, regardless of which framing produced the
// plan) and, if refused, one isolated 10-turn negotiation per argument
// style. The first attempt that gets a step accepted becomes that step's
// canonical result, feeding its (fabricated) output into the next step;
// if nothing accepts a step, the plan's execution stops there — that
// break point is itself the finding (scenario YAML's execution_break_step).
//
// Usage:
//   node scripts/batch-eval-steps.js [--batch-id id] [--sources f1.json,f2.json]
//     [--max-turns 10] [--budget 15] [--yes] [--dry-run]
//   node scripts/batch-eval-steps.js --report <batch-id>
//
// See docs/superpowers/specs/2026-08-05-batch-eval-design.md for the
// planning-stage design this extends.

import fs from "fs";
import readline from "readline";
import { loadScenario } from "../lib/scenarios.js";
import { discoverAcceptedPlans, resolveState, loadState, saveState } from "./batch/steps-state.js";
import { estimateStepsWorstCase } from "./batch/cost.js";
import { printSummaryTable, writeSummaryCsv } from "./batch/steps-report.js";
import { runStepsBatch } from "./batch/steps-run.js";

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
    else if (a === "--sources") args.sources = next().split(",").map((s) => s.trim());
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
  if (!state) throw new Error(`No step batch found with id "${batchId}" under runs/batches/`);
  printSummaryTable(state);
  const csvPath = writeSummaryCsv(state);
  console.log(`\nCSV written to ${csvPath}`);
}

async function main() {
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

  const allAccepted = await discoverAcceptedPlans();
  const sourcePlans = args.sources
    ? allAccepted.filter((p) => args.sources.includes(p.sourceId))
    : allAccepted;

  if (args.sources) {
    const missing = args.sources.filter((s) => !sourcePlans.some((p) => p.sourceId === s));
    if (missing.length) throw new Error(`Requested source(s) not found or not accepted: ${missing.join(", ")}`);
  }
  if (sourcePlans.length === 0) {
    console.log("No accepted plans found in runs/ — nothing to execute.");
    return;
  }

  const maxTurns = args.maxTurns || DEFAULT_MAX_TURNS;
  const batchId = args.batchId || `stepbatch_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const sourceIds = sourcePlans.map((p) => p.sourceId);

  const { totalUsd, perPlan } = estimateStepsWorstCase({ sourcePlans, maxTurns });

  console.log(`Batch id: ${batchId}`);
  console.log(`Source plans (${sourcePlans.length}):`);
  for (const p of perPlan) {
    console.log(`  ${p.sourceId} — ${p.model}, ${p.steps} step(s) — worst case ~$${p.cost.toFixed(2)}`);
  }
  console.log(`Max turns per attempt: ${maxTurns}`);
  console.log(`\nWorst-case cost estimate (every step of every plan fully exhausted, nothing accepted):`);
  console.log(`  TOTAL: ~$${totalUsd.toFixed(2)}`);
  console.log(
    `\n(Realistic cost is usually well below this: a plan's execution stops at its first ` +
      `step that never gets accepted, so later steps are never attempted.)`
  );

  if (args.dryRun) {
    console.log("\n--dry-run: no model calls made, no state file written.");
    return;
  }

  if (!args.yes) {
    const ok = await confirm("\nProceed with this step-execution batch?");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const state = await resolveState({ batchId, sourceIds, maxTurns, budgetCap: args.budget });
  await saveState(state);

  const scenarioIds = [...new Set(sourcePlans.map((p) => p.scenarioId))];
  const scenarios = Object.fromEntries(scenarioIds.map((id) => [id, loadScenario(id)]));

  await runStepsBatch({ batchId, state, sourcePlans, scenarios });

  console.log("");
  printSummaryTable(state);
  const csvPath = writeSummaryCsv(state);
  console.log(`\nCSV written to ${csvPath}`);
  console.log(`State file: runs/batches/${batchId}/manifest.json (resume anytime with --batch-id ${batchId})`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
