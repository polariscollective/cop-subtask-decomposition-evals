import fs from "fs";
import path from "path";
import { buildInitialAttempts } from "./matrix.js";

const BATCHES_DIR = path.join(process.cwd(), "runs", "batches");

function batchDir(batchId) {
  return path.join(BATCHES_DIR, batchId);
}

function statePath(batchId) {
  return path.join(batchDir(batchId), "state.json");
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function loadState(batchId) {
  const p = statePath(batchId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveState(state) {
  fs.mkdirSync(batchDir(state.batch_id), { recursive: true });
  fs.writeFileSync(statePath(state.batch_id), JSON.stringify(state, null, 2), "utf8");
}

// Loads an existing batch's state if present (validating the requested
// matrix parameters still match what's on disk, since resuming with a
// different model/scenario/turn-budget list would silently produce a
// half-mixed matrix), or creates a fresh one.
export function resolveState({ batchId, models, scenarioIds, maxTurns, budgetCap }) {
  const existing = loadState(batchId);
  if (existing) {
    if (!sameSet(existing.models, models) || !sameSet(existing.scenario_ids, scenarioIds)) {
      throw new Error(
        `Batch "${batchId}" already exists on disk with models=[${existing.models}] ` +
          `scenarios=[${existing.scenario_ids}], which differs from the requested ` +
          `models=[${models}] scenarios=[${scenarioIds}]. Use a different --batch-id, ` +
          `or omit --models/--scenarios to resume with the stored matrix.`
      );
    }
    if (existing.max_turns !== maxTurns) {
      throw new Error(
        `Batch "${batchId}" was created with --max-turns ${existing.max_turns}, ` +
          `but ${maxTurns} was requested. Use a different --batch-id, or omit ` +
          `--max-turns to resume with the stored value.`
      );
    }
    // budget_cap is the one parameter explicitly meant to change across
    // resumes (e.g. raising it after an earlier run stopped at the cap).
    if (budgetCap !== undefined) existing.budget_cap = budgetCap;
    return existing;
  }

  return {
    batch_id: batchId,
    models,
    scenario_ids: scenarioIds,
    max_turns: maxTurns,
    budget_cap: budgetCap ?? null,
    cumulative_cost: 0,
    created_at: new Date().toISOString(),
    attempts: buildInitialAttempts({ models, scenarioIds }),
  };
}

export function batchSummaryPath(batchId, filename) {
  return path.join(batchDir(batchId), filename);
}
