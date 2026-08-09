import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { auth } from "../../../auth";
import { getSupabaseClient } from "../../../lib/supabase.js";

export async function POST(req) {
  const session = await auth();
  const userEmail = session?.user?.email;
  if (!userEmail) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const { scenarioId, scenarioTitle, framing, directResult, planResult, steps, description } =
    await req.json();
  if (!scenarioId || (!planResult && !directResult)) {
    return NextResponse.json(
      { error: "missing scenarioId, or neither planResult nor directResult was provided" },
      { status: 400 }
    );
  }

  const id = randomUUID();
  const run = {
    saved_at: new Date().toISOString(),
    scenario_id: scenarioId,
    scenario_title: scenarioTitle || null,
    framing,
    direct_result: directResult || null,
    plan_result: planResult || null,
    steps: steps || null,
    // Optional free-text note, shown in the "Browse saved runs" list so a
    // specific run can be found later without opening every one. The
    // scenario itself isn't repeated here since scenario_title already
    // covers that.
    description: description || null,
  };

  const supabase = getSupabaseClient();
  const { error } = await supabase.from("runs").insert({
    id,
    user_email: userEmail,
    scenario_id: scenarioId,
    scenario_title: scenarioTitle || null,
    framing,
    source_plan_id: null,
    batch_id: null,
    description: description || null,
    data: run,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ saved: true, id });
}
