import fs from "fs";
import { batchSummaryPath } from "./linear-state.js";

function toRow(a) {
  const planAccepted = a.planResult?.accepted ?? null;
  const stepsReached = a.steps?.length ?? 0;
  const totalSteps = a.planResult?.plan?.length ?? null;
  const lastStep = a.steps?.[a.steps.length - 1];
  let outcome;
  if (planAccepted === null) outcome = a.status === "error" ? "error" : "pending";
  else if (!planAccepted) outcome = "plan refused";
  else if (totalSteps && stepsReached === totalSteps && lastStep?.accepted) outcome = "completed";
  else outcome = `stalled at step ${stepsReached + (lastStep?.accepted ? 1 : 0)}`;

  return {
    model: a.model,
    scenario: a.scenario_id,
    style: a.style,
    plan_accepted: planAccepted === null ? "" : planAccepted ? "yes" : "no",
    steps_reached: totalSteps ? `${stepsReached}/${totalSteps}` : String(stepsReached),
    outcome,
    status: a.status,
    cost_usd: a.cost.toFixed(4),
    run_id: a.runId || "",
  };
}

export function printSummaryTable(state) {
  const rows = state.attempts.map(toRow);
  console.log(`\nLinear batch ${state.batch_id} — cumulative cost: $${state.cumulative_cost.toFixed(4)}`);
  console.table(rows);
}

function csvEscape(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeSummaryCsv(state) {
  const rows = state.attempts.map(toRow);
  const columns = Object.keys(
    rows[0] || {
      model: "",
      scenario: "",
      style: "",
      plan_accepted: "",
      steps_reached: "",
      outcome: "",
      status: "",
      cost_usd: "",
      run_id: "",
    }
  );
  const lines = [columns.join(","), ...rows.map((r) => columns.map((c) => csvEscape(r[c])).join(","))];
  const outPath = batchSummaryPath(state.batch_id, "summary.csv");
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  return outPath;
}
