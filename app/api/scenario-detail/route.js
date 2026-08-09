import { NextResponse } from "next/server";
import { validateScenarioDoc } from "../../../lib/scenarios";
import { getSessionEmail } from "../../../auth";
import { getSupabaseClient } from "../../../lib/supabase.js";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from("scenarios")
    .select("data, created_by, deleted_at")
    .eq("scenario_id", scenarioId)
    .single();
  if (error || !row) {
    return NextResponse.json({ error: `Scenario not found: ${scenarioId}` }, { status: 404 });
  }

  return NextResponse.json({ ...row.data, created_by: row.created_by, deleted: row.deleted_at != null });
}

async function requireOwnedScenario(scenarioId) {
  const userEmail = await getSessionEmail();
  if (!userEmail) return { error: NextResponse.json({ error: "not signed in" }, { status: 401 }) };

  const supabase = getSupabaseClient();
  const { data: existing, error } = await supabase
    .from("scenarios")
    .select("created_by")
    .eq("scenario_id", scenarioId)
    .single();
  if (error || !existing) {
    return { error: NextResponse.json({ error: `Scenario not found: ${scenarioId}` }, { status: 404 }) };
  }
  if (existing.created_by !== userEmail) {
    return { error: NextResponse.json({ error: "only the creator can modify this scenario" }, { status: 403 }) };
  }
  return { supabase };
}

export async function PUT(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }

  const { supabase, error: authError } = await requireOwnedScenario(scenarioId);
  if (authError) return authError;

  const body = await req.json();
  const doc = { ...body, scenario_id: scenarioId }; // scenario_id is immutable
  const { ok, errors } = validateScenarioDoc(doc);
  if (!ok) {
    return NextResponse.json({ ok: false, errors }, { status: 400 });
  }

  const { error: updateError } = await supabase
    .from("scenarios")
    .update({
      title: doc.title,
      dilemma_id: doc.dilemma_id || null,
      updated_at: new Date().toISOString(),
      data: doc,
    })
    .eq("scenario_id", scenarioId);
  if (updateError) {
    return NextResponse.json({ ok: false, errors: [{ field: "root", message: updateError.message }] }, { status: 500 });
  }

  return NextResponse.json({ ok: true, scenario_id: scenarioId });
}

export async function DELETE(req) {
  const { searchParams } = new URL(req.url);
  const scenarioId = searchParams.get("scenarioId");
  if (!scenarioId) {
    return NextResponse.json({ error: "missing scenarioId" }, { status: 400 });
  }

  const { supabase, error: authError } = await requireOwnedScenario(scenarioId);
  if (authError) return authError;

  const { error: updateError } = await supabase
    .from("scenarios")
    .update({ deleted_at: new Date().toISOString() })
    .eq("scenario_id", scenarioId);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
