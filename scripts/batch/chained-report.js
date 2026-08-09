import fs from "fs";
import { batchSummaryPath } from "./chained-state.js";

function toRow(a) {
  const dr = a.directResult;
  const toolsCalled = dr?.tools_called?.length ?? 0;
  const totalTools = dr?.total_tools ?? null;
  const outcome =
    dr == null ? (a.status === "error" ? "error" : "pending") : dr.accepted ? "completed" : `stopped at ${toolsCalled}/${totalTools}`;
  return {
    model: a.model,
    scenario: a.scenario_id,
    style: a.style,
    tools_called: totalTools ? `${toolsCalled}/${totalTools}` : String(toolsCalled),
    tools_list: dr?.tools_called?.join(" → ") || "",
    outcome,
    status: a.status,
    cost_usd: a.cost.toFixed(4),
    run_id: a.runId || "",
  };
}

export function printSummaryTable(state) {
  const rows = state.attempts.map(toRow);
  console.log(`\nChained batch ${state.batch_id} — cumulative cost: $${state.cumulative_cost.toFixed(4)}`);
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
      tools_called: "",
      tools_list: "",
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
