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

export default auth((req) => {
  if (skipAuthInDev) return NextResponse.next();
  if (req.auth) return NextResponse.next();

  const isApiRoute = req.nextUrl.pathname.startsWith("/api/");
  if (isApiRoute) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", req.nextUrl.href);
  return NextResponse.redirect(signInUrl);
});

// Everything is gated except: Auth.js's own endpoints, Next's static assets,
// and the public compare view. That last group is /compare plus the three
// endpoints it reads — each of which does its own session check and serves
// nothing but published runs to an anonymous caller (see app/api/compare,
// app/api/runs and app/api/scenario-detail). The (?:/|$) on each keeps the
// carve-out from matching a longer sibling path like /compare-internal.
export const config = {
  matcher: [
    "/((?!api/auth(?:/|$)|api/compare(?:/|$)|api/runs(?:/|$)|api/scenario-detail(?:/|$)|compare(?:/|$)|_next/static|_next/image|favicon.ico).*)",
  ],
};
