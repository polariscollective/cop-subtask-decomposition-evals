#!/usr/bin/env node
// Grades scenarios that are already in the bank and stores the result in
// scenario_metrics.
//
// The generate screen grades candidates before they are saved, and that verdict
// was never persisted — promoting a candidate threw it away. So every scenario
// in the bank carried no record of why it was judged good enough to keep. This
// script fills that in, and is also how you re-grade after a revision or with a
// second judge from another model family (F-08).
//
// Usage:
//   node scripts/grade-scenario.js                       # every live scenario
//   node scripts/grade-scenario.js --scenarios a,b       # just these
//   node scripts/grade-scenario.js --judge gpt-5.6-terra # default
//   node scripts/grade-scenario.js --dry-run             # print, store nothing
//
// Two independent passes per scenario, deliberately not merged:
//   1. the five dimensions, judged with the whole scenario in view;
//   2. per-step legibility, judged with ONE step in view and nothing else
//      (lib/blind-view.js). Merging them would put the whole chain back in
//      front of the grader and reproduce the contamination that pass exists to
//      remove.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_GRADING_REPEATS,
  DEFAULT_THRESHOLD,
  THRESHOLD_DIMENSIONS,
  ceilingFor,
  foldGradings,
  isBorderline,
  stepsOverCeiling,
} from "../lib/legibility.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Same helper the batch runners use, and for the same reason: .env.local must
// WIN over whatever is already in the shell. A shell that exports a stale
// ANTHROPIC_API_KEY otherwise shadows the real one, and the failure looks like
// a model refusal rather than an auth error.
function loadEnvLocalOverriding(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
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
loadEnvLocalOverriding(path.join(ROOT, ".env.local"));

// Imported after the env is loaded: these read process.env at module scope.
const { providerForModel } = await import("../lib/models.js");
const { getSupabaseClient } = await import("../lib/supabase.js");
// Both passes live in lib/grading.js, shared with scripts/generate-scenarios.js
// so a candidate is admitted to the bank on the same measurement it is later
// re-graded with.
const { gradeOnce } = await import("../lib/grading.js");

// Different model family from the generator on purpose — a judge that grades
// its own family's writing is a self-preference confound the project cannot
// afford. Same default as the generate page.
const DEFAULT_JUDGE = "gpt-5.6-terra";

function parseArgs(argv) {
  const args = { dryRun: false, judge: DEFAULT_JUDGE, repeat: DEFAULT_GRADING_REPEATS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenarios") args.scenarios = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--judge") args.judge = argv[++i];
    else if (a === "--repeat") args.repeat = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("node scripts/grade-scenario.js [--scenarios a,b] [--judge model] [--repeat n] [--dry-run]");
    console.log(`  --repeat defaults to ${DEFAULT_GRADING_REPEATS}: one grading is noisy by about a point, and the gates sit exactly there.`);
    return;
  }

  const author = process.env.RUN_AUTHOR_EMAIL;
  if (!author && !args.dryRun) {
    console.error("RUN_AUTHOR_EMAIL must be set — this script runs outside any Auth.js session.");
    process.exit(1);
  }

  const supabase = getSupabaseClient();
  let query = supabase.from("scenarios").select("scenario_id, title, data, updated_at").is("deleted_at", null);
  if (args.scenarios?.length) query = query.in("scenario_id", args.scenarios);
  const { data: rows, error } = await query;
  if (error) {
    console.error(`could not read scenarios: ${error.message}`);
    process.exit(1);
  }
  if (!rows?.length) {
    console.error("no matching live scenarios");
    process.exit(1);
  }

  const provider = providerForModel(args.judge);
  let total = 0;

  for (const row of rows) {
    const doc = row.data;
    // Stamped on every grading so a later reader can tell which wording it
    // scored — the median must not mix passes taken across an edit.
    const gradedAt = row.updated_at ?? null;
    process.stdout.write(`\n${row.scenario_id} — judging with ${args.judge}…\n`);

    // Sequentially, not in parallel: the passes are cheap and a provider that
    // rate-limits mid-sweep would otherwise lose several at once.
    const gradings = [];
    for (let pass = 1; pass <= args.repeat; pass++) {
      const grading = await gradeOnce({ doc, judge: args.judge, provider });
      const { dims, leg, cost } = grading;
      total += cost;
      gradings.push(grading);
      console.log(
        `  pass ${pass}/${args.repeat}: ` +
          THRESHOLD_DIMENSIONS.map((k) => dims.verdict.scores?.[k]?.score ?? "?").join(" ") +
          `  legibility [${leg.steps.map((s) => s.score ?? "?").join(", ")}]  $${cost.toFixed(4)}`
      );
      if (dims.verdict.error) console.log(`    ! dimensions: ${dims.verdict.error}`);
      const legErrors = leg.steps.filter((s) => s.error);
      if (legErrors.length) console.log(`    ! legibility step(s) ${legErrors.map((s) => s.step).join(", ")}`);
    }

    // The verdict is the median, and the spread is printed with it: a single
    // grading moves by about a point, so "4" alone reads as settled when it is
    // not. A range that straddles a gate is the thing to notice.
    const folded = foldGradings(gradings);
    const ceiling = ceilingFor(folded.dimensions);
    console.log(`  — median of ${folded.n} —`);
    for (const key of THRESHOLD_DIMENSIONS) {
      const v = folded.dimensions[key];
      if (!v) continue;
      const spread = v.min === v.max ? "" : ` (${v.min}-${v.max})`;
      console.log(`  ${key}: ${v.score}/5${spread}${v.score < DEFAULT_THRESHOLD ? "   BELOW FLOOR" : ""}`);
    }
    const loud = stepsOverCeiling(folded.legibility, ceiling);
    console.log(
      `  legibility: [${folded.legibility
        .map((s) => (s.min === s.max ? `${s.score}` : `${s.score}(${s.min}-${s.max})`))
        .join(", ")}]  ceiling ${ceiling}` + (loud.length ? `   OVER CEILING at step ${loud.map((s) => s.step).join(", ")}` : "")
    );
    if (isBorderline(folded, DEFAULT_THRESHOLD)) {
      console.log("  ! borderline — at least one pass disagreed about whether this clears");
    }

    if (args.dryRun) continue;

    // One row per pass, never a merged one. The median is derived on read, so
    // a later re-grade can be folded in with these rather than replacing them,
    // and two judges disagreeing stays visible.
    for (const g of gradings) {
      const { error: insertError } = await supabase.from("scenario_metrics").insert({
        scenario_id: row.scenario_id,
        judge_model: args.judge,
        judge_provider: provider,
        dimensions: g.dimensions,
        legibility: g.legibility,
        cost: g.cost,
        created_by: author,
        graded_scenario_updated_at: gradedAt,
      });
      if (insertError) console.error(`  ! could not store: ${insertError.message}`);
    }
    console.log(`  stored ${gradings.length} grading(s)`);
  }

  console.log(`\ntotal $${total.toFixed(4)}`);
}

await main();
