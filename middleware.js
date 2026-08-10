import { NextResponse } from "next/server";
import { auth } from "./auth";

// Local dev only: skip the Google sign-in gate entirely so the app is
// reachable (including by tools that can't drive an OAuth flow) without
// ever weakening anything in production — this never runs when
// NODE_ENV === "production".
//
// Gated on the SAME two conditions as auth.js's getSessionEmail(), so the
// app has exactly one opt-in switch rather than two independently-armed
// ones. Requiring NODE_ENV alone would fire even when the operator has
// deliberately left LOCAL_AUTHENTICATION_NEEDED unset — and middleware is
// the only session check five routes have (ask-direct, plan, execute-step,
// compare, batch/status), three of which spend real money on the org's
// provider keys. `next dev` binds every interface, so that combination
// exposes them on any shared network.
const skipAuthInDev =
  process.env.NODE_ENV !== "production" && process.env.LOCAL_AUTHENTICATION_NEEDED === "false";

// Exact paths readable without a session. A Set of exact strings rather than
// a pattern: the negative-lookahead matcher this replaces produced two
// separate path-boundary defects, and both were the same shape — a string
// that merely STARTED with a public path was treated as public. Exact
// matching cannot express that bug, so /comparex can never inherit
// /compare's access.
//
// Note this is per-path, not per-route-tree: adding app/api/runs/foo/route.js
// would NOT make it public, it would have to be listed here. That is the
// safer default, and the opposite of what the old matcher did.
const PUBLIC_PATHS = new Set(["/compare", "/api/compare", "/api/runs", "/api/scenario-detail"]);

// Auth.js's own endpoints are a genuine subtree (/api/auth/signin,
// /api/auth/callback/google, …), so this one is a prefix test — with the
// trailing slash, so /api/authx doesn't match it.
function isPublicPath(pathname) {
  // Next.js normalises trailing slashes before middleware, but strip one
  // anyway so a direct request for /api/runs/ resolves like /api/runs. The
  // length guard keeps "/" from normalising to "".
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return PUBLIC_PATHS.has(path) || path === "/api/auth" || path.startsWith("/api/auth/");
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (skipAuthInDev) return NextResponse.next();
  if (req.auth) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", req.nextUrl.href);
  return NextResponse.redirect(signInUrl);
});

// Only static assets skip middleware now — the access decision lives in the
// handler above, not in this pattern. Each exclusion is anchored: the two
// directories with a trailing slash, favicon with an escaped dot and $.
// Left unanchored (as they were), /favicon.icoX and /_next/staticfoo skip
// the gate entirely, which is the same defect this file has already had
// twice.
export const config = {
  matcher: ["/((?!_next/static/|_next/image/|favicon\\.ico$).*)"],
};
