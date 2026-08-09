// Folds a group of same-combo samples (same pipeline/model/scenario/style)
// into one aggregate: the deepest attempt wins as "best", with counts
// carried alongside so a caller can show every attempt, not just the
// winner. Shared between /api/compare's server-side grouping and
// app/compare/page.js's client-side re-aggregation after a creator/batch
// filter narrows which samples are in play — same math, one definition.
export function aggregateSamples(samples) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => (a.saved_at || "").localeCompare(b.saved_at || ""));
  const best = sorted.reduce((a, b) => (b.depth > a.depth ? b : a));
  const completedCount = sorted.filter((s) => s.completed).length;
  return {
    pipeline: best.pipeline,
    model: best.model,
    scenario: best.scenario,
    scenario_title: best.scenario_title,
    style: best.style,
    depth: best.depth,
    fullSteps: best.fullSteps,
    completed: best.completed,
    planAccepted: best.planAccepted,
    planFraming: best.planFraming,
    turnsUsed: best.turnsUsed,
    id: best.id,
    sampleCount: sorted.length,
    completedCount,
    anyRunning: sorted.some((s) => s.inProgress),
    samples: sorted,
  };
}
