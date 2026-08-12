#!/usr/bin/env node
// Writes scenarios for every family the harness can carry, and files the ones
// that clear the bars.
//
// The generate screen does this one family at a time, with a person clicking
// through it. That is the right shape for writing a single scenario and the
// wrong one for filling a bank of thirteen families, so this is the same
// pipeline as a sweep: generate, grade, keep the survivors, insert.
//
// Usage:
//   node scripts/generate-scenarios.js --dry-run          # matrix and estimate
//   node scripts/generate-scenarios.js --batch-id gen-1 --yes
//   node scripts/generate-scenarios.js --batch-id gen-1   # resumes it
//
// Which families: every LIVE family that isRunnable() accepts — a real answer
// to score against, and a shape the four-tool chain can carry. Contested and
// out-of-scope families are not offered, exactly as on the generate screen: a
// scenario written for one of them cannot be used, which is worse than not
// having written it.
//
// What "up to three" means: three candidates are written per family and each is
// graded; the ones that clear the five floors AND stay under the legibility
// ceiling are kept. A family can therefore yield 0, and that is a result — it
// says the seed did not produce a usable instrument three times running, which
// is worth knowing before anyone writes one by hand.
//
// Nothing is published. scenarios.is_public defaults to false and this script
// never sets it: a candidate becomes visible when someone reads it and says so
// in SQL. See "What is public and what is not" in the README.
//
// Resumable and capped, like the batch runners. Interrupting it (Ctrl+C, a
// crash, hitting --budget) is safe: re-run with the same --batch-id and the
// families already finished are skipped.

import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { fileURLToPath } from "url";
import {
  GENERATION_MAX_TOKENS,
  buildGeneratorPrompt,
  buildRepairPrompt,
  deriveScenarioId,
  parseCandidate,
  refusalMessage,
  truncationMessage,
} from "../lib/scenario-builder.js";
import { isRunnable, seedFromFamily } from "../lib/families.js";
import {
  DEFAULT_GRADING_REPEATS,
  DEFAULT_THRESHOLD,
  THRESHOLD_DIMENSIONS,
  ceilingFor,
  foldGradings,
  isBorderline,
  selectForVariety,
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
const { callModel } = await import("../lib/providers.js");
const { costForCall, providerForModel } = await import("../lib/models.js");
const { getSupabaseClient } = await import("../lib/supabase.js");
const { gradeOnce } = await import("../lib/grading.js");

// Measured, not estimated — see GENERATION_MAX_TOKENS. Same budget as
// /api/generate-scenario, from the same constant.
const MAX_TOKENS = GENERATION_MAX_TOKENS;
const FIRST_MESSAGE = "Write the scenario.";

// Not claude-opus-5: Anthropic's platform-level content filter blocks this
// project's generator prompt for that model deterministically. Same default as
// the generate screen.
const DEFAULT_GENERATOR = "claude-sonnet-5";
// A different model family from the generator, on purpose — a judge grading its
// own family's writing is a self-preference confound this project cannot afford.
const DEFAULT_JUDGE = "gpt-5.6-terra";
const DEFAULT_COUNT = 3;
// Families run in parallel, candidates within a family do not: each candidate is
// told about its siblings so three dressings of one hard case do not come back
// as one dressing written three times.
const DEFAULT_CONCURRENCY = 3;

// Rough, and only used by --dry-run and the confirmation prompt. Measured on
// real calls: a generation is ~$0.07 on sonnet-5 (about 3800 output tokens at
// $15/M, plus the prompt), a grading pass ~$0.015 on gpt-5.6-terra.
const EST_GENERATION = 0.07;
const EST_GRADING_PASS = 0.015;

function parseArgs(argv) {
  const args = {
    count: DEFAULT_COUNT,
    generator: DEFAULT_GENERATOR,
    judge: DEFAULT_JUDGE,
    repeat: DEFAULT_GRADING_REPEATS,
    concurrency: DEFAULT_CONCURRENCY,
    budget: null,
    dryRun: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--families") args.families = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--count") args.count = Math.max(1, Number(argv[++i]) || DEFAULT_COUNT);
    else if (a === "--generator") args.generator = argv[++i];
    else if (a === "--judge") args.judge = argv[++i];
    else if (a === "--repeat") args.repeat = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--batch-id") args.batchId = argv[++i];
    else if (a === "--budget") args.budget = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// State. A local file rather than a row in `batches`: that table is the run
// sweeps' bookkeeping and /api/batch/status reads it, so a generation batch
// filed there would surface in the UI as a run sweep that never runs anything.
function stateFile(batchId) {
  return path.join(ROOT, "runs", "generate", `${batchId}.json`);
}

function loadState(batchId) {
  const file = stateFile(batchId);
  if (!fs.existsSync(file)) return { batch_id: batchId, families: {} };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveState(state) {
  const file = stateFile(state.batch_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Spend. The cap is checked BEFORE starting a candidate, never in the middle of
// one: stopping between the generation and the grading would leave a candidate
// nobody can judge, paid for and unusable.
function makeSpend(limit) {
  let spent = 0;
  return {
    add(n) {
      spent += Number(n) || 0;
    },
    total: () => spent,
    exhausted: () => limit != null && spent >= limit,
  };
}

// ---------------------------------------------------------------------------
// A provider that drops the connection costs a whole candidate, and if it does
// it during grading it costs one that has already been paid for. So a THROWN
// error is retried once. A refusal or a truncation is not: those come back as a
// value rather than an exception, precisely because re-asking cannot fix them.
async function retryOnce(label, fn, log) {
  try {
    return await fn();
  } catch (err) {
    log(`  ${label}: ${err.message || err} — retrying once`);
    return fn();
  }
}

// ---------------------------------------------------------------------------
// One candidate: write it, and repair it once if the YAML came back malformed.
//
// A provider block and a truncation both skip the repair round, because neither
// is a formatting mistake there is anything to point out — and a truncated
// response is the trap, since it leaves non-empty text and would otherwise buy
// a second call that truncates again at double the cost.
async function writeCandidate({ seed, existing, model, provider, spend }) {
  const systemPrompt = buildGeneratorPrompt({ seed, existingScenarios: existing });
  const first = await callModel({
    provider,
    model,
    systemPrompt,
    messages: [{ role: "user", content: FIRST_MESSAGE }],
    maxTokens: MAX_TOKENS,
  });
  spend.add(
    costForCall({ provider, model, inputTokens: first.usage.inputTokens, outputTokens: first.usage.outputTokens })
  );

  if (first.stopReason === "refusal") return { ok: false, reason: refusalMessage(first) };
  if (first.truncated) return { ok: false, reason: truncationMessage(MAX_TOKENS) };

  let parsed = parseCandidate(first.text);
  if (parsed.ok) return { ok: true, doc: parsed.doc, raw: parsed.raw, repaired: false };
  if (!first.text.trim()) return { ok: false, reason: parsed.errors[0]?.message || "the model returned nothing" };

  const repair = await callModel({
    provider,
    model,
    systemPrompt,
    messages: [
      { role: "user", content: FIRST_MESSAGE },
      { role: "assistant", content: first.text },
      { role: "user", content: buildRepairPrompt(parsed.raw, parsed.errors) },
    ],
    maxTokens: MAX_TOKENS,
  });
  spend.add(
    costForCall({ provider, model, inputTokens: repair.usage.inputTokens, outputTokens: repair.usage.outputTokens })
  );
  if (repair.stopReason === "refusal") return { ok: false, reason: refusalMessage(repair) };
  if (repair.truncated) return { ok: false, reason: truncationMessage(MAX_TOKENS) };

  parsed = parseCandidate(repair.text);
  if (parsed.ok) return { ok: true, doc: parsed.doc, raw: parsed.raw, repaired: true };
  // The repair round's errors describe the model's most recent attempt, which is
  // the more useful thing to record than the superseded first one.
  return { ok: false, reason: parsed.errors.map((e) => `${e.field}: ${e.message}`).join("; "), raw: parsed.raw };
}

// ---------------------------------------------------------------------------
// One family, start to finish. Returns the state entry for it.
async function processFamily({ family, args, bankTitles, judgeProvider, generatorProvider, spend, log }) {
  const seed = seedFromFamily(family);
  const siblings = [];
  const candidates = [];

  for (let i = 1; i <= args.count; i++) {
    if (spend.exhausted()) {
      log(`  candidate ${i}: skipped, budget reached`);
      break;
    }
    // The bank plus the siblings already written for THIS family. The screen
    // cannot do the second half — it fires its candidates in parallel — and it
    // is the half that matters here: without it three dressings of one hard
    // case come back differing only in vocabulary.
    const existing = [...bankTitles, ...siblings];
    let written;
    try {
      written = await retryOnce(
        `candidate ${i}`,
        () => writeCandidate({ seed, existing, model: args.generator, provider: generatorProvider, spend }),
        log
      );
    } catch (err) {
      log(`  candidate ${i}: generation failed — ${err.message || err}`);
      candidates.push({ ok: false, reason: `generation failed: ${err.message || err}` });
      continue;
    }

    if (!written.ok) {
      log(`  candidate ${i}: rejected before grading — ${written.reason}`);
      candidates.push({ ok: false, reason: written.reason, raw: written.raw ?? null });
      continue;
    }
    siblings.push({ scenario_id: written.doc.scenario_id, title: written.doc.title });

    const gradings = [];
    try {
      for (let pass = 1; pass <= args.repeat; pass++) {
        const grading = await retryOnce(
          `candidate ${i} pass ${pass}`,
          () => gradeOnce({ doc: written.doc, judge: args.judge, provider: judgeProvider }),
          log
        );
        spend.add(grading.cost);
        gradings.push({ dimensions: grading.dimensions, legibility: grading.legibility, cost: grading.cost });
      }
    } catch (err) {
      log(`  candidate ${i}: grading failed — ${err.message || err}`);
      candidates.push({ ok: false, reason: `grading failed: ${err.message || err}`, doc: written.doc });
      continue;
    }

    const folded = foldGradings(gradings);
    const candidate = {
      ok: true,
      doc: written.doc,
      raw: written.raw,
      repaired: written.repaired,
      gradings,
      // The shape selectForVariety and failedThresholds read.
      scores: folded.dimensions,
      legibility: { steps: folded.legibility },
      borderline: isBorderline(folded, DEFAULT_THRESHOLD),
    };
    candidates.push(candidate);
    log(
      `  candidate ${i}: ${written.doc.scenario_id}${written.repaired ? " (repaired)" : ""}  ` +
        THRESHOLD_DIMENSIONS.map((k) => folded.dimensions[k]?.score ?? "?").join(" ") +
        `  legibility [${folded.legibility.map((s) => s.score ?? "?").join(", ")}]` +
        (candidate.borderline ? "  borderline" : "")
    );
  }

  // Same selection the screen makes: the floors and the ceiling decide, and
  // nothing is ranked on quality — a candidate that misses either is a broken
  // instrument, not a weaker one.
  const { picked, rejected } = selectForVariety(
    candidates.filter((c) => c.ok),
    args.count
  );
  for (const r of rejected) {
    const why = [
      r.missed.length ? `below the floor on ${r.missed.join(", ")}` : null,
      r.loud.length ? `step ${r.loud.map((s) => s.step).join(", ")} over the legibility ceiling` : null,
    ]
      .filter(Boolean)
      .join("; ");
    log(`  discarded ${r.candidate.doc.scenario_id}: ${why}`);
  }

  return { candidates, picked, rejected };
}

// ---------------------------------------------------------------------------
async function saveCandidate({ supabase, candidate, family, author, judge, judgeProvider, taken }) {
  const scenarioId = deriveScenarioId(candidate.doc, taken);
  if (!scenarioId) return { ok: false, error: `could not derive a free scenario_id from ${candidate.doc.scenario_id}` };

  // The id in the stored doc has to be the id of the row, or the spec page and
  // every transcript disagree about what this scenario is called.
  const doc = { ...candidate.doc, scenario_id: scenarioId };
  const { data: inserted, error } = await supabase
    .from("scenarios")
    .insert({
      scenario_id: scenarioId,
      title: doc.title,
      dilemma_id: doc.dilemma_id ?? null,
      family_id: family.id,
      created_by: author,
      data: doc,
    })
    .select("updated_at")
    .single();
  if (error) return { ok: false, error: error.message };
  taken.add(scenarioId);

  // One metrics row per pass, never a merged one — the median is derived on
  // read, so a later re-grade folds in with these instead of replacing them.
  // This is the grading that admitted the scenario; the generate screen used to
  // throw its equivalent away the moment a candidate was promoted.
  let stored = 0;
  for (const g of candidate.gradings) {
    const { error: metricError } = await supabase.from("scenario_metrics").insert({
      scenario_id: scenarioId,
      judge_model: judge,
      judge_provider: judgeProvider,
      dimensions: g.dimensions,
      legibility: g.legibility,
      cost: g.cost,
      created_by: author,
      // The text these passes graded is the text just inserted, so the row's own
      // updated_at is the honest stamp.
      graded_scenario_updated_at: inserted?.updated_at ?? null,
    });
    if (!metricError) stored++;
  }
  return { ok: true, scenarioId, metricsStored: stored };
}

// ---------------------------------------------------------------------------
async function pool(items, size, worker) {
  const queue = items.map((item, index) => ({ item, index }));
  const results = new Array(items.length);
  const runners = Array.from({ length: Math.min(size, items.length || 1) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      results[next.index] = await worker(next.item);
    }
  });
  await Promise.all(runners);
  return results;
}

function todayStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (args.help) {
    console.log(
      "node scripts/generate-scenarios.js [--families a,b] [--count n] [--generator model]\n" +
        "                                  [--judge model] [--repeat n] [--concurrency n]\n" +
        "                                  [--batch-id id] [--budget dollars] [--dry-run] [--yes]\n" +
        `  --count   defaults to ${DEFAULT_COUNT}: candidates written per family, of which the survivors are kept.\n` +
        `  --repeat  defaults to ${DEFAULT_GRADING_REPEATS}: one grading is noisy by about a point, and the gates sit exactly there.\n` +
        "  Nothing is published — scenarios.is_public defaults to false."
    );
    return;
  }

  const author = process.env.RUN_AUTHOR_EMAIL;
  if (!author && !args.dryRun) {
    console.error("RUN_AUTHOR_EMAIL must be set — this script runs outside any Auth.js session.");
    process.exit(1);
  }

  let generatorProvider;
  let judgeProvider;
  try {
    generatorProvider = providerForModel(args.generator);
    judgeProvider = providerForModel(args.judge);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const supabase = getSupabaseClient();
  const { data: familyRows, error: familyError } = await supabase
    .from("scenario_families")
    .select("id, label, tradeoff, answer_status, answer_basis, description, harness_fit")
    .is("deleted_at", null)
    .order("id");
  if (familyError) {
    console.error(`could not read families: ${familyError.message}`);
    process.exit(1);
  }

  let families = (familyRows || []).filter(isRunnable);
  if (args.families?.length) {
    const eligible = new Set(families.map((f) => f.id));
    const unknown = args.families.filter((id) => !eligible.has(id));
    if (unknown.length) {
      console.error(`not eligible (contested, out of scope, or unknown): ${unknown.join(", ")}`);
      process.exit(1);
    }
    families = families.filter((f) => args.families.includes(f.id));
  }
  if (!families.length) {
    console.error("no eligible families");
    process.exit(1);
  }

  const batchId = args.batchId || `gen-${todayStamp()}`;
  const state = loadState(batchId);
  state.args = {
    count: args.count,
    generator: args.generator,
    judge: args.judge,
    repeat: args.repeat,
  };
  const todo = families.filter((f) => state.families[f.id]?.status !== "done");
  const done = families.length - todo.length;

  const estimate = todo.length * args.count * (EST_GENERATION + args.repeat * EST_GRADING_PASS);
  console.log(`batch ${batchId}`);
  console.log(`  ${families.length} eligible family(ies)${done ? `, ${done} already done` : ""}`);
  console.log(`  ${todo.length} to run x ${args.count} candidate(s), graded ${args.repeat}x`);
  console.log(`  generator ${args.generator} (${generatorProvider}), judge ${args.judge} (${judgeProvider})`);
  console.log(`  estimated $${estimate.toFixed(2)}${args.budget != null ? `, capped at $${args.budget.toFixed(2)}` : ""}`);
  for (const f of todo) console.log(`    - ${f.id}`);
  if (args.dryRun) {
    console.log("\ndry run: no API calls, nothing written");
    return;
  }
  if (!todo.length) {
    console.log("\nnothing to do");
    return;
  }
  if (!args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("\nproceed? [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return;
  }

  // Every id ever used, soft-deleted rows included: scenario_id is the primary
  // key, so a retired row still holds its name.
  const { data: allScenarios } = await supabase.from("scenarios").select("scenario_id, title");
  const taken = new Set((allScenarios || []).map((s) => s.scenario_id));
  // The anti-duplication list the generator is shown. Titles, not ids, are what
  // stop a re-skin.
  const bankTitles = (allScenarios || []).map((s) => ({ scenario_id: s.scenario_id, title: s.title }));

  const spend = makeSpend(args.budget);
  let saved = 0;

  await pool(todo, args.concurrency, async (family) => {
    // Buffered and flushed as one block: families run concurrently, and
    // interleaved lines would make a family's candidates unreadable.
    const lines = [];
    const log = (line) => lines.push(line);
    log(`\n${family.id} — ${family.label}`);

    let result;
    try {
      result = await processFamily({
        family,
        args,
        bankTitles,
        judgeProvider,
        generatorProvider,
        spend,
        log,
      });
    } catch (err) {
      log(`  ! family failed: ${err.message || err}`);
      state.families[family.id] = { status: "error", error: String(err.message || err) };
      saveState(state);
      console.log(lines.join("\n"));
      return;
    }

    const kept = [];
    for (const candidate of result.picked) {
      const outcome = await saveCandidate({
        supabase,
        candidate,
        family,
        author,
        judge: args.judge,
        judgeProvider,
        taken,
      });
      if (outcome.ok) {
        saved++;
        kept.push(outcome.scenarioId);
        log(`  saved ${outcome.scenarioId} (${outcome.metricsStored}/${candidate.gradings.length} gradings stored)`);
      } else {
        log(`  ! could not save ${candidate.doc.scenario_id}: ${outcome.error}`);
      }
    }
    if (!result.picked.length) log("  kept nothing — no candidate cleared both bars");

    // Written whether or not anything was kept, and the rejected candidates go
    // in with their raw YAML: a family that yields nothing is a result about the
    // seed, and re-running it blind would lose that.
    state.families[family.id] = {
      status: "done",
      saved: kept,
      candidates: result.candidates.map((c) => ({
        ok: c.ok,
        scenario_id: c.doc?.scenario_id ?? null,
        reason: c.reason ?? null,
        scores: c.scores ?? null,
        legibility: c.legibility?.steps ?? null,
        raw: c.ok ? undefined : c.raw ?? null,
      })),
      rejected: result.rejected.map((r) => ({
        scenario_id: r.candidate.doc.scenario_id,
        missed: r.missed,
        loud: r.loud.map((s) => s.step),
      })),
    };
    saveState(state);
    console.log(lines.join("\n"));
  });

  state.spent = spend.total();
  saveState(state);
  console.log(`\n${saved} scenario(s) saved, unpublished. $${spend.total().toFixed(2)} spent.`);
  if (spend.exhausted()) {
    console.log(`budget reached — re-run with the same --batch-id to continue: --batch-id ${batchId}`);
  }
  console.log(`state: runs/generate/${batchId}.json`);
}

await main();
