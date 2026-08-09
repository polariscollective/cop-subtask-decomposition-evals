#!/usr/bin/env node
// One-off migration: copies every local runs/*.json and
// runs/batches/<batch_id>/manifest.json into Supabase. Safe to re-run —
// the `legacy_filename` unique constraint means a second pass on a
// runs/*.json file is a no-op (upsert on conflict does nothing new), and
// batch rows are upserted by batch_id.
//
// Usage: node scripts/migrate-runs-to-supabase.js
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { getSupabaseClient } from "../lib/supabase.js";

const RUNS_DIR = path.join(process.cwd(), "runs");
const BATCHES_DIR = path.join(RUNS_DIR, "batches");
const MIGRATED_USER_EMAIL = "sam@polariscollective.org";

async function migrateRuns(supabase) {
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
  console.log(`Found ${files.length} local run files.`);

  // Rows already migrated (by legacy_filename) are skipped, not
  // re-inserted — makes the script idempotent across re-runs.
  const { data: already, error: selErr } = await supabase.from("runs").select("legacy_filename");
  if (selErr) throw new Error(`Failed to list existing runs: ${selErr.message}`);
  const alreadyMigrated = new Set((already || []).map((r) => r.legacy_filename).filter(Boolean));

  const filenameToId = new Map();
  let inserted = 0;
  for (const filename of files) {
    if (alreadyMigrated.has(filename)) {
      // Still need the mapping for the batch-manifest pass below.
      const { data: existing, error: lookupErr } = await supabase
        .from("runs")
        .select("id")
        .eq("legacy_filename", filename)
        .single();
      if (lookupErr) throw new Error(`Failed to look up already-migrated run ${filename}: ${lookupErr.message}`);
      filenameToId.set(filename, existing.id);
      continue;
    }

    const content = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, filename), "utf8"));
    const id = randomUUID();
    filenameToId.set(filename, id);

    const { error } = await supabase.from("runs").insert({
      id,
      created_at: content.saved_at || new Date().toISOString(),
      user_email: MIGRATED_USER_EMAIL,
      scenario_id: content.scenario_id,
      scenario_title: content.scenario_title || null,
      framing: content.framing || null,
      source_plan_id: null, // resolved in the second pass below, once every filename has an id
      batch_id: content.batch_id || null,
      description: content.description || null,
      legacy_filename: filename,
      data: content,
    });
    if (error) throw new Error(`Failed to insert ${filename}: ${error.message}`);
    inserted++;
  }
  console.log(`Inserted ${inserted} new run rows (${alreadyMigrated.size} already migrated).`);
  return filenameToId;
}

// source_plan_id in the original files is itself a legacy filename (the
// plan row a step continues from) — now that every legacy file has a real
// uuid, rewrite each migrated row's source_plan_id to point at that uuid
// instead, so chain grouping (see app/api/runs/route.js) keeps working.
async function fixSourcePlanIds(supabase, filenameToId) {
  const { data: rows, error } = await supabase
    .from("runs")
    .select("id, data")
    .not("legacy_filename", "is", null);
  if (error) throw new Error(`Failed to list migrated runs: ${error.message}`);

  let fixed = 0;
  for (const row of rows) {
    const oldSourceFilename = row.data.source_plan_id;
    if (!oldSourceFilename) continue;
    const newSourceId = filenameToId.get(oldSourceFilename);
    if (!newSourceId || newSourceId === row.data.source_plan_id) continue;

    const updatedData = { ...row.data, source_plan_id: newSourceId };
    const { error: updErr } = await supabase
      .from("runs")
      .update({ source_plan_id: newSourceId, data: updatedData })
      .eq("id", row.id);
    if (updErr) throw new Error(`Failed to fix source_plan_id on ${row.id}: ${updErr.message}`);
    fixed++;
  }
  console.log(`Rewrote source_plan_id on ${fixed} step rows.`);
}

async function migrateBatches(supabase, filenameToId) {
  if (!fs.existsSync(BATCHES_DIR)) return;
  const batchDirs = fs.readdirSync(BATCHES_DIR).filter((d) => fs.existsSync(path.join(BATCHES_DIR, d, "manifest.json")));
  console.log(`Found ${batchDirs.length} local batch manifests.`);

  let migrated = 0;
  for (const batchId of batchDirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(BATCHES_DIR, batchId, "manifest.json"), "utf8"));
    // Old manifests record each attempt's identifier as `filename`; rewrite
    // to `runId` pointing at the row's new uuid, matching the shape every
    // pipeline now writes going forward (see scripts/batch/*-state.js).
    manifest.attempts = (manifest.attempts || []).map(({ filename, ...rest }) => ({
      ...rest,
      runId: filename ? filenameToId.get(filename) || null : null,
    }));

    const { error } = await supabase
      .from("batches")
      .upsert({ id: batchId, user_email: MIGRATED_USER_EMAIL, data: manifest });
    if (error) throw new Error(`Failed to migrate batch ${batchId}: ${error.message}`);
    migrated++;
  }
  console.log(`Migrated ${migrated} batch rows.`);
}

async function main() {
  const supabase = getSupabaseClient();
  const filenameToId = await migrateRuns(supabase);
  await fixSourcePlanIds(supabase, filenameToId);
  await migrateBatches(supabase, filenameToId);
  console.log("Migration complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
