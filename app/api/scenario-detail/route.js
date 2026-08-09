import { NextResponse } from "next/server";
import { loadScenario } from "../../../lib/scenarios";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }
  try {
    const scenario = await loadScenario(scenarioId);
    return NextResponse.json(scenario);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
}
