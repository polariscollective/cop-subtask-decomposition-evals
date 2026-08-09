#!/usr/bin/env node
// One-off migration: copies the local scenarios/*.yaml files into Supabase.
// Safe to re-run — scenario_id is the primary key, so an already-migrated
// scenario is skipped, not re-inserted.
//
// Usage: RUN_AUTHOR_EMAIL=you@example.com node scripts/migrate-scenarios-to-supabase.js
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { getSupabaseClient } from "../lib/supabase.js";
import { validateScenarioDoc } from "../lib/scenarios.js";

const SCENARIOS_DIR = path.join(process.cwd(), "scenarios");

async function main() {
  if (!process.env.RUN_AUTHOR_EMAIL) {
    console.error("RUN_AUTHOR_EMAIL must be set (the email to attribute these scenarios to).");
    process.exit(1);
  }

  const supabase = getSupabaseClient();
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".yaml"));
  console.log(`Found ${files.length} local scenario files.`);

  const { data: already, error: selErr } = await supabase.from("scenarios").select("scenario_id");
  if (selErr) throw new Error(`Failed to list existing scenarios: ${selErr.message}`);
  const alreadyMigrated = new Set((already || []).map((r) => r.scenario_id));

  let inserted = 0;
  for (const file of files) {
    const raw = fs.readFileSync(path.join(SCENARIOS_DIR, file), "utf8");
    const doc = yaml.load(raw);

    const { ok, errors } = validateScenarioDoc(doc);
    if (!ok) {
      console.error(`Skipping ${file}: invalid scenario doc`, errors);
      continue;
    }

    if (alreadyMigrated.has(doc.scenario_id)) {
      console.log(`Skipping ${file} (${doc.scenario_id}): already migrated.`);
      continue;
    }

    const { error } = await supabase.from("scenarios").insert({
      scenario_id: doc.scenario_id,
      title: doc.title,
      dilemma_id: doc.dilemma_id || null,
      created_by: process.env.RUN_AUTHOR_EMAIL,
      data: doc,
    });
    if (error) throw new Error(`Failed to insert ${file}: ${error.message}`);
    console.log(`Inserted ${doc.scenario_id} (from ${file}).`);
    inserted++;
  }
  console.log(`Migration complete. Inserted ${inserted} new scenario rows (${alreadyMigrated.size} already present).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
