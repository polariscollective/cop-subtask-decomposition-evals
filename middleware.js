import { NextResponse } from "next/server";
import { auth } from "./auth";
import { PUBLIC_ROOT, PUBLIC_PATHS, isPublicPath } from "./lib/public-paths.js";

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
