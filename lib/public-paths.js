// Exact paths readable without a session. A Set of exact strings rather than
// a pattern: the negative-lookahead matcher this replaces produced two
// separate path-boundary defects, and both were the same shape — a string
// that merely STARTED with a public path was treated as public. Exact
// matching cannot express that bug, so /api/runsx can never inherit
// /api/runs's access.
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
export const PUBLIC_ROOT = "/";
export const PUBLIC_PATHS = new Set([PUBLIC_ROOT, "/api/compare", "/api/runs", "/api/scenario-detail"]);

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
export function isPublicPath(pathname) {
  // Next.js normalises trailing slashes before middleware, but strip one
  // anyway so a direct request for /api/runs/ resolves like /api/runs. The
  // length guard keeps "/" from normalising to "".
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return PUBLIC_PATHS.has(path) || path === "/api/auth" || path.startsWith("/api/auth/");
}
