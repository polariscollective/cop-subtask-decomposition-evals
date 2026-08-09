import { NextResponse } from "next/server";
import { getSupabaseClient } from "../../../../lib/supabase.js";

const STALE_THRESHOLD_MINUTES = Number(process.env.BATCH_STALE_THRESHOLD_MINUTES || 30);

function isTerminal(status) {
  return status === "done" || status === "error";
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const batchId = searchParams.get("batchId");
  if (!batchId) {
    return NextResponse.json({ error: "batchId is required" }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase.from("batches").select("data, updated_at").eq("id", batchId).single();
  if (error || !row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const manifest = row.data;
  let attempts = manifest.attempts || [];

  const allTerminal = attempts.length > 0 && attempts.every((a) => isTerminal(a.status));
  const minutesSinceUpdate = (Date.now() - new Date(row.updated_at).getTime()) / 60000;
  const isStale = !allTerminal && minutesSinceUpdate > STALE_THRESHOLD_MINUTES;

  if (isStale) {
    // Correct the stored manifest too, so other consumers (e.g. /api/compare's
    // anyRunning flag, which reads this same table) stop reporting it as live —
    // not just this one response.
    attempts = attempts.map((a) =>
      isTerminal(a.status)
        ? a
        : { ...a, status: "error", error: `Stalled — no update in over ${STALE_THRESHOLD_MINUTES} minutes` }
    );
    const { error: updateError } = await supabase
      .from("batches")
      .update({ data: { ...manifest, attempts } })
      .eq("id", batchId);
    if (updateError) {
      // Don't fail the whole response over a failed correction — the
      // client-facing status below is still accurate either way.
      console.error(`Failed to correct stalled batch ${batchId}: ${updateError.message}`);
    }
  }

  // "accepted" isn't on the manifest attempt itself (see plan's Global
  // Constraints note) — fetch it in one batched query for every attempt
  // that has finished and has a runId.
  const doneRunIds = attempts.filter((a) => a.runId && a.status === "done").map((a) => a.runId);
  const acceptedByRunId = new Map();
  if (doneRunIds.length > 0) {
    const { data: runs } = await supabase.from("runs").select("id, data").in("id", doneRunIds);
    for (const r of runs || []) {
      const accepted = r.data.plan_result?.accepted ?? r.data.direct_result?.accepted ?? null;
      acceptedByRunId.set(r.id, accepted);
    }
  }

  const responseAttempts = attempts.map((a) => ({
    id: a.id,
    model: a.model,
    scenario: a.scenario_id,
    style: a.style,
    status: a.status,
    accepted: a.runId ? acceptedByRunId.get(a.runId) ?? null : null,
    cost: a.cost || 0,
  }));

  const status = isStale ? "stalled" : allTerminal ? "done" : "running";
  const cumulativeCost = responseAttempts.reduce((sum, a) => sum + a.cost, 0);

  return NextResponse.json({ batchId, status, cumulativeCost, attempts: responseAttempts });
}
