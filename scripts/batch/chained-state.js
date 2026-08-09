import fs from "fs";
import path from "path";
import { getSupabaseClient } from "../../lib/supabase.js";

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// Same simplification as the linear pipeline: a chain is cheap and
// self-contained, so on resume an incomplete attempt just restarts from
// scratch rather than trying to restore a mid-negotiation tool-slot.
export async function loadState(batchId) {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase.from("batches").select("data").eq("id", batchId).single();
  // PGRST116 = no row matched .single() — a legitimate "batch doesn't exist
  // yet" case. Any other error (network, auth, permissions) must not be
  // read as "no existing batch": resolveState() would silently start a
  // fresh batch and re-run everything from scratch instead of surfacing
  // the failure, double-spending on a transient blip.
  if (error && error.code !== "PGRST116") throw new Error(`Failed to load batch ${batchId}: ${error.message}`);
  if (!row) return null;
  const manifest = row.data;
  manifest.attempts = await Promise.all(
    manifest.attempts.map(async (a) => {
      if (!a.runId) return { ...a, directResult: null };
      const { data: runRow, error: runError } = await supabase.from("runs").select("data").eq("id", a.runId).single();
      if (runError && runError.code !== "PGRST116") {
        throw new Error(`Failed to load run ${a.runId} for batch ${batchId}: ${runError.message}`);
      }
      if (!runRow) return { ...a, directResult: null };
      return { ...a, directResult: runRow.data.direct_result };
    })
  );
  return manifest;
}

export async function saveState(state) {
  const supabase = getSupabaseClient();
  const manifest = { ...state, attempts: state.attempts.map(({ directResult, ...rest }) => rest) };
  const { error } = await supabase
    .from("batches")
    .upsert({ id: state.batch_id, user_email: process.env.RUN_AUTHOR_EMAIL, data: manifest });
  if (error) throw new Error(`Failed to save batch ${state.batch_id}: ${error.message}`);
}

export async function resolveState({ batchId, models, scenarioIds, styles, maxTurns, budgetCap }) {
  const existing = await loadState(batchId);
  if (existing) {
    if (
      !sameSet(existing.models, models) ||
      !sameSet(existing.scenario_ids, scenarioIds) ||
      !sameSet(existing.styles, styles) ||
      existing.max_turns !== maxTurns
    ) {
      throw new Error(
        `Batch "${batchId}" already exists with a different matrix (models/scenarios/styles/max_turns). ` +
          `Use a different --batch-id, or omit those flags to resume with the stored matrix.`
      );
    }
    if (budgetCap !== undefined) existing.budget_cap = budgetCap;
    return existing;
  }

  const attempts = [];
  for (const model of models) {
    for (const scenarioId of scenarioIds) {
      for (const style of styles) {
        attempts.push({
          id: `${model}|${scenarioId}|${style}`,
          model,
          scenario_id: scenarioId,
          style,
          status: "pending",
          runId: null,
          cost: 0,
          error: null,
        });
      }
    }
  }

  return {
    batch_id: batchId,
    models,
    scenario_ids: scenarioIds,
    styles,
    max_turns: maxTurns,
    budget_cap: budgetCap ?? null,
    cumulative_cost: 0,
    created_at: new Date().toISOString(),
    attempts,
  };
}

export function batchSummaryPath(batchId, filename) {
  const dir = path.join(process.cwd(), "runs", "batches", batchId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}
