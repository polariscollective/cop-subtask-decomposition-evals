import fs from "fs";
import path from "path";
import { buildInitialAttempts } from "./matrix.js";
import { readRunFile } from "./runfile.js";
import { getSupabaseClient } from "../../lib/supabase.js";

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// The batch row is bookkeeping only — which attempts exist, their status,
// cost, and which run row (attempt.runId) holds their actual content. It
// never stores turns/messages itself; those live in each attempt's
// individual run row (see runfile.js) so that row can be browsed/continued
// in the manual dashboard independently of the batch that produced it.
function stripHeavy(attempt) {
  const { turns, messages, ...rest } = attempt;
  return rest;
}

export async function saveState(state) {
  const supabase = getSupabaseClient();
  const manifest = { ...state, attempts: state.attempts.map(stripHeavy) };
  const { error } = await supabase
    .from("batches")
    .upsert({ id: state.batch_id, user_email: process.env.RUN_AUTHOR_EMAIL, data: manifest });
  if (error) throw new Error(`Failed to save batch ${state.batch_id}: ${error.message}`);
}

// Loads the batch row and hydrates each attempt's turns/messages back from
// its run row (if it has one yet), so the runner can resume a
// mid-negotiation attempt exactly where it left off.
export async function loadState(batchId) {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase.from("batches").select("data").eq("id", batchId).single();
  if (error || !row) return null;
  const manifest = row.data;
  manifest.attempts = await Promise.all(
    manifest.attempts.map(async (a) => {
      if (!a.runId) return { ...a, turns: [], messages: [] };
      const runFile = await readRunFile(a.runId);
      return {
        ...a,
        turns: runFile.plan_result?.turns || [],
        messages: runFile.plan_result?.messages || [],
      };
    })
  );
  return manifest;
}

// Loads an existing batch's state if present (validating the requested
// matrix parameters still match what's stored, since resuming with a
// different model/scenario/turn-budget list would silently produce a
// half-mixed matrix), or creates a fresh one.
export async function resolveState({ batchId, models, scenarioIds, maxTurns, budgetCap }) {
  const existing = await loadState(batchId);
  if (existing) {
    if (!sameSet(existing.models, models) || !sameSet(existing.scenario_ids, scenarioIds)) {
      throw new Error(
        `Batch "${batchId}" already exists with models=[${existing.models}] ` +
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

// summary.csv still lands on the local disk the batch script runs on —
// that's a human-readable report artifact, not the source of truth for
// runs, so it's out of scope for the Supabase migration (see design doc's
// "Out of scope").
export function batchSummaryPath(batchId, filename) {
  const dir = path.join(process.cwd(), "runs", "batches", batchId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}
