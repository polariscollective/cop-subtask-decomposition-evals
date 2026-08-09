import fs from "fs";
import { batchSummaryPath } from "./steps-state.js";

function executorTurnCount(attempt) {
  return attempt.turns.filter((t) => t.role === "executor").length;
}

function platformBlockedCount(attempt) {
  return attempt.turns.filter((t) => t.platform_blocked).length;
}

function toRow(attempt) {
  return {
    source_plan: attempt.source_id,
    model: attempt.model,
    scenario: attempt.scenario_id,
    step_index: attempt.step_index,
    style: attempt.style || "(baseline)",
    status: attempt.status,
    accepted: attempt.accepted === null ? "" : attempt.accepted ? "yes" : "no",
    accepted_at_turn: attempt.accepted_at_turn ?? "",
    executor_turns: executorTurnCount(attempt),
    platform_blocked_turns: platformBlockedCount(attempt),
    cost_usd: attempt.cost.toFixed(4),
    run_id: attempt.runId || "",
  };
}

export function printSummaryTable(state) {
  const rows = state.attempts.map(toRow);
  console.log(`\nStep batch ${state.batch_id} — cumulative cost: $${state.cumulative_cost.toFixed(4)}`);
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
      source_plan: "",
      model: "",
      scenario: "",
      step_index: "",
      style: "",
      status: "",
      accepted: "",
      accepted_at_turn: "",
      executor_turns: "",
      platform_blocked_turns: "",
      cost_usd: "",
      run_id: "",
    }
  );
  const lines = [
    columns.join(","),
    ...rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")),
  ];
  const outPath = batchSummaryPath(state.batch_id, "summary.csv");
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  return outPath;
}
