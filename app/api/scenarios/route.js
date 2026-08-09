import { NextResponse } from "next/server";
import { listScenarios } from "../../../lib/scenarios";

export async function GET() {
  return NextResponse.json(await listScenarios());
}
