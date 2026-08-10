import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPublicPath, PUBLIC_ROOT, PUBLIC_PATHS } from "../lib/public-paths.js";

// middleware.js's config.matcher MUST stay a literal string in that file —
// Next.js statically analyses that export at build time, so it can never be
// replaced with an imported constant. That means this test cannot import the
// matcher; it has to read middleware.js as text and pull the pattern out
// with a regex instead, or the matcher and this boundary table could drift
// out of sync with nothing to catch it — which is exactly the failure mode
// three prior reviews caught by hand.
const middlewarePath = fileURLToPath(new URL("../middleware.js", import.meta.url));
const middlewareSource = readFileSync(middlewarePath, "utf8");

const matcherArrayMatch = middlewareSource.match(/matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"\s*\]/);
assert.ok(matcherArrayMatch, "could not find a literal config.matcher string in middleware.js");

// The regex above captures the JS string literal's raw source text (e.g. the
// two literal backslash characters that spell `\\.` in the file), not its
// runtime value. Route that through JSON.parse to apply the same escaping
// rules a JS string literal uses (both treat \\ and \" the same way), which
// is what turns it back into the actual pattern middleware.js hands to
// Next.js.
const matcherPattern = JSON.parse('"' + matcherArrayMatch[1] + '"');

// The matcher is written as `/(<inner>)` — a leading slash plus one capture
// group wrapping everything else. Reproduce that shape anchored to a full
// path match, the same way middleware.js's own comment describes it: the
// regex decides whether a request reaches the handler at all, so testing it
// standalone (not just isPublicPath) is the only way to catch the exclusion
// pattern silently drifting from what the handler expects.
assert.ok(matcherPattern.startsWith("/("), "matcher pattern should start with /(");
assert.ok(matcherPattern.endsWith(")"), "matcher pattern should end with )");
const inner = matcherPattern.slice(2, -1);
const matcherRegex = new RegExp("^/(" + inner + ")$");

// Known-good sanity checks on the conversion itself, before trusting it for
// the full boundary table below: if the extraction or the RegExp conversion
// is subtly wrong (e.g. an unescaped `.`, or the wrong slice offsets), these
// fail loudly and specifically rather than the whole table silently passing
// or failing for the wrong reason.
assert.equal(matcherRegex.test("/api/auth"), false, "matcher should exclude /api/auth");
assert.equal(matcherRegex.test("/dashboard"), true, "matcher should reach /dashboard");
assert.equal(matcherRegex.test("/favicon.ico"), false, "matcher should exclude /favicon.ico");

// A request has exactly one of three fates:
//  - "skipped": the matcher excludes it, so middleware never runs at all
//    (static assets, Auth.js's own endpoints).
//  - "open": middleware runs but isPublicPath lets it through unauthenticated.
//  - "gated": middleware runs and requires a session.
function classify(pathname) {
  if (!matcherRegex.test(pathname)) return "skipped";
  return isPublicPath(pathname) ? "open" : "gated";
}

// Each row here reproduces a boundary defect this file has actually had:
// a string starting with a public/skipped path (comparex, imagex,
// staticfoo, favicon.icoX, authx) must NOT inherit that path's treatment,
// and a trailing slash or missing/dangling segment must resolve the same
// way the equivalent clean path does.
const BOUNDARY_TABLE = [
  ["/", "open"],
  ["/dashboard", "gated"],
  ["/runs", "gated"],
  ["/batch", "gated"],
  ["/scenarios", "gated"],
  ["/compare", "gated"],
  ["/comparex", "gated"],
  ["/compare-internal", "gated"],
  ["/dashboard-internal", "gated"],
  ["/api/compare", "open"],
  ["/api/runs", "open"],
  ["/api/runs/", "open"],
  ["/api/runs/foo", "gated"],
  ["/api/scenario-detail", "open"],
  ["/api/save-run", "gated"],
  ["/api/plan", "gated"],
  ["/api/auth", "skipped"],
  ["/api/auth/signin", "skipped"],
  ["/api/auth/callback/google", "skipped"],
  ["/api/authx", "gated"],
  ["/_next/image", "skipped"],
  ["/_next/image/x.png", "skipped"],
  ["/_next/imagex", "gated"],
  ["/_next/static/chunk.js", "skipped"],
  ["/_next/staticfoo", "gated"],
  ["/favicon.ico", "skipped"],
  ["/favicon.icoX", "gated"],
];

for (const [pathname, expected] of BOUNDARY_TABLE) {
  test(`${pathname} is ${expected}`, () => {
    assert.equal(classify(pathname), expected);
  });
}

test("PUBLIC_ROOT is a member of PUBLIC_PATHS, so the unauthenticated redirect cannot loop", () => {
  // PUBLIC_ROOT is where middleware sends every unauthenticated page
  // request. If it were ever not in PUBLIC_PATHS, that redirect would land
  // back on a gated path and redirect again forever. Asserting membership
  // (rather than just that "/" classifies as open) pins the actual
  // structural property middleware.js's comment relies on.
  assert.equal(PUBLIC_PATHS.has(PUBLIC_ROOT), true);
});
