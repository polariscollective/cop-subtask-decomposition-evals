import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const RUNS_DIR = path.join(process.cwd(), "runs");

export async function POST(req) {
  const { scenarioId, scenarioTitle, framing, directResult, planResult, steps } = await req.json();
  if (!scenarioId || (!planResult && !directResult)) {
    return NextResponse.json(
      { error: "missing scenarioId, or neither planResult nor directResult was provided" },
      { status: 400 }
    );
  }

  fs.mkdirSync(RUNS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const mode = planResult ? "plan" : "direct";
  const filename = `${timestamp}_${scenarioId}_${framing}_${mode}.json`;

  const run = {
    saved_at: new Date().toISOString(),
    scenario_id: scenarioId,
    scenario_title: scenarioTitle || null,
    framing,
    direct_result: directResult || null,
    plan_result: planResult || null,
    steps: steps || null,
  };

  fs.writeFileSync(path.join(RUNS_DIR, filename), JSON.stringify(run, null, 2), "utf8");

  return NextResponse.json({ saved: true, filename });
}
