// How many steps of a run's chain were actually reached, as filled segments.
//
// It lives here rather than in the comparison grid because that is no longer
// where it belongs: every figure in the grid is now a rate averaged over
// styles and scenarios, and a bar drawn from the single deepest attempt sat
// oddly beside them. Inside a transcript, where you are looking at one run,
// "it got 3 of 4 tools in" is exactly the right thing to show.
//
// `total` is per-scenario — chains are 4-5 tools — never hardcoded.
export default function StepBar({ depth, total }) {
  const n = Math.max(0, total || 0);
  return (
    <span className="cmp-bar" role="img" aria-label={`${depth} of ${n} steps reached`}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={i < depth ? "cmp-seg on" : "cmp-seg"} />
      ))}
    </span>
  );
}
