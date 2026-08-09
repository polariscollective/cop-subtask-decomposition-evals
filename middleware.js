import { NextResponse } from "next/server";
import { auth } from "./auth";

// Local dev only: skip the Google sign-in gate entirely so the app is
// reachable (including by tools that can't drive an OAuth flow) without
// ever weakening anything in production — this never runs when
// NODE_ENV === "production".
const skipAuthInDev = process.env.NODE_ENV !== "production";

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

export const config = {
  matcher: ["/((?!api/auth(?:/|$)|_next/static|_next/image|favicon.ico).*)"],
};
