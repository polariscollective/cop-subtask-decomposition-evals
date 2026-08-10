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
//
// The public landing page, and the destination for any unauthenticated page
// request. Named once and used in both places so the no-loop property is
// structural rather than a coincidence of two literals agreeing: the
// redirect target is a member of PUBLIC_PATHS by construction, so it is
// always let through before the redirect branch can fire.
const PUBLIC_ROOT = "/";
const PUBLIC_PATHS = new Set([PUBLIC_ROOT, "/api/compare", "/api/runs", "/api/scenario-detail"]);

// Auth.js's own endpoints are a genuine subtree (/api/auth/signin,
// /api/auth/callback/google, …), so this one is a prefix test — with the
// trailing slash, so /api/authx doesn't match it.
//
// The matcher below excludes api/auth too, so in the committed config this
// branch is unreachable: every /api/auth/* request is already skipped
// before it gets here. It stays anyway as the one deliberate redundancy in
// this file. If the matcher's api/auth exclusion is ever narrowed or
// dropped by a future edit, middleware would start running on Auth.js's
// own endpoints again — and without this check, every one of them would
// read as gated, locking every user out of signing in.
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

  // Unauthenticated page requests land on the public root rather than the
  // sign-in screen — the banner there is the way in. See PUBLIC_ROOT above
  // for why this cannot loop.
  return NextResponse.redirect(new URL(PUBLIC_ROOT, req.nextUrl.origin));
});

// Four exclusions skip middleware entirely; everything else reaches the
// handler above, which makes the access decision. Each is anchored with
// (?:/|$) — directory-or-exact-end — except favicon.ico$, which is a single
// file so a literal $ is enough. Unanchored (as _next/static and
// _next/image were before this fix), a bare prefix match lets a longer
// sibling path ride along for free: /favicon.icoX, /_next/staticfoo and
// bare /_next/image (Next's image optimizer's actual pathname — the
// ?url=…&w=…&q=… it's always requested with is a query string, not part of
// what the matcher sees) would all wrongly skip the gate. That is the same
// defect this file has already had twice, so /api/authx, /_next/imagex and
// /_next/staticfoo must all stay gated.
//
// api/auth is excluded here — at the matcher level — rather than left to
// isPublicPath's handler-level check, so middleware never runs on Auth.js's
// own endpoints at all, full stop. Running and then waving the request
// through with NextResponse.next() is not equivalent: the auth() wrapper
// this file exports resolves the session before the handler callback ever
// executes, and appends any resulting Set-Cookie to the response regardless
// of what the callback returns. On /api/auth/signout or
// /api/auth/callback/*, that stray middleware-originated cookie would race
// the Set-Cookie NextAuth's own handler sets for the same request — a
// cookie race on the sign-in/sign-out critical path. Excluding api/auth in
// the matcher is the only way to keep middleware from executing there.
export const config = {
  matcher: ["/((?!api/auth(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$).*)"],
};
