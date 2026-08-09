import fs from "fs";
import path from "path";
import { readRunFile } from "./steps-runfile.js";
import { getSupabaseClient } from "../../lib/supabase.js";

// Scans every saved run for one whose plan was accepted — these are the
// candidates for step execution. Each row's plan_result is embedded,
// unmodified, into every step-attempt row this source plan produces.
export async function discoverAcceptedPlans() {
  const supabase = getSupabaseClient();
  const { data: rows, error } = await supabase.from("runs").select("id, data");
  if (error) throw new Error(`Failed to list runs: ${error.message}`);
  const plans = [];
  for (const row of rows) {
    const content = row.data;
    const pr = content.plan_result;
    // Older saved runs (pre-dating the model/turns/messages fields this
    // project now always writes) can't be executed — nothing to call, no
    // conversation to seed a negotiation from. Skip them rather than crash.
    if (pr?.accepted && Array.isArray(pr.plan) && pr.plan.length > 0 && pr.model && pr.messages?.length) {
      plans.push({
        sourceId: row.id,
        scenarioId: content.scenario_id,
        model: pr.model,
        planResult: pr,
        plan: pr.plan,
      });
    }
  }
  return plans;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

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
      if (!a.runId) return { ...a, turns: [], messages: [] };
      const runFile = await readRunFile(a.runId);
      const own = runFile.steps[runFile.steps.length - 1];
      return {
        ...a,
        turns: own?.turns || [],
        messages: own?.messages || [],
        output: own?.output ?? null,
      };
    })
  );
  return manifest;
}

export async function saveState(state) {
  const supabase = getSupabaseClient();
  const manifest = {
    ...state,
    attempts: state.attempts.map(({ turns, messages, output, ...rest }) => rest),
  };
  const { error } = await supabase
    .from("batches")
    .upsert({ id: state.batch_id, user_email: process.env.RUN_AUTHOR_EMAIL, data: manifest });
  if (error) throw new Error(`Failed to save batch ${state.batch_id}: ${error.message}`);
}

export async function resolveState({ batchId, sourceIds, maxTurns, budgetCap }) {
  const existing = await loadState(batchId);
  if (existing) {
    if (!sameSet(existing.source_ids, sourceIds)) {
      throw new Error(
        `Step batch "${batchId}" already exists with a different set of source plans. ` +
          `Use a different --batch-id, or omit --sources to resume with the stored set.`
      );
    }
    if (existing.max_turns !== maxTurns) {
      throw new Error(
        `Step batch "${batchId}" was created with --max-turns ${existing.max_turns}, but ${maxTurns} ` +
          `was requested. Use a different --batch-id, or omit --max-turns to resume with the stored value.`
      );
    }
    if (budgetCap !== undefined) existing.budget_cap = budgetCap;
    return existing;
  }

  return {
    batch_id: batchId,
    source_ids: sourceIds,
    max_turns: maxTurns,
    budget_cap: budgetCap ?? null,
    cumulative_cost: 0,
    created_at: new Date().toISOString(),
    attempts: [],
  };
}

export function batchSummaryPath(batchId, filename) {
  const dir = path.join(process.cwd(), "runs", "batches", batchId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}
