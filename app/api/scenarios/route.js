import { NextResponse } from "next/server";
import { listScenarios, normalizeScenarioDoc, validateScenarioDoc } from "../../../lib/scenarios";
import { getSessionEmail } from "../../../auth";
import { getSupabaseClient } from "../../../lib/supabase.js";

export async function GET() {
  // listScenarios throws if Supabase is unreachable. Without this, the
  // route 500s with an empty body, and callers doing `res.json()` get a
  // SyntaxError instead of a message — the scenario picker then sits
  // silently empty with nothing explaining why.
  try {
    return NextResponse.json(await listScenarios());
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  const userEmail = await getSessionEmail();
  if (!userEmail) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  let submitted;
  try {
    submitted = await req.json();
  } catch {
    return NextResponse.json({ ok: false, errors: [{ field: "root", message: "body must be JSON" }] }, { status: 400 });
  }
  const { ok, errors } = validateScenarioDoc(submitted);
  if (!ok) {
    return NextResponse.json({ ok: false, errors }, { status: 400 });
  }
  const doc = normalizeScenarioDoc(submitted);

  const supabase = getSupabaseClient();
  const { error } = await supabase.from("scenarios").insert({
    scenario_id: doc.scenario_id,
    title: doc.title,
    dilemma_id: doc.dilemma_id,
    created_by: userEmail,
    data: doc,
  });
  // Let the primary key decide uniqueness rather than checking first and
  // inserting after — a check-then-insert loses the race between two
  // concurrent creates and turns the second one into a raw 500.
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { ok: false, errors: [{ field: "scenario_id", message: `scenario_id "${doc.scenario_id}" already exists` }] },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: false, errors: [{ field: "root", message: error.message }] }, { status: 500 });
  }

  return NextResponse.json({ ok: true, scenario_id: doc.scenario_id });
}
