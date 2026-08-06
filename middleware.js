import { NextResponse } from "next/server";
import { auth } from "./auth";

export default auth((req) => {
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
