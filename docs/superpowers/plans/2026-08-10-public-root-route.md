# Public root route — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/` the public compare view, move the manual runner to `/dashboard`, and send unauthenticated visitors to `/` instead of the sign-in screen.

**Architecture:** Three ordered tasks, sequenced so the committed tree is correct and deployable after every one. Task 1 replaces `middleware.js`'s negative-lookahead matcher with an explicit `PUBLIC_PATHS` set checked in the handler — a behaviour-preserving refactor of the security boundary, reviewable on its own. Task 2 swaps the route topology in a single atomic commit (the three file moves, the `/compare` redirect, and the one-line `PUBLIC_PATHS` change from `/compare` to `/`) because splitting it would leave a commit where the public view is unreachable. Task 3 repoints internal links and the README.

**Tech Stack:** Next.js 14 (App Router), React 18 client components, Auth.js v5 (`next-auth@5-beta`), plain CSS. No test framework — verification is pure-node assertion scripts plus curl against production builds of the committed tree, matching this repo's existing convention.

**Spec:** `docs/superpowers/specs/2026-08-10-public-root-route-design.md`

## Global Constraints

- No new dependencies. **No test framework** — this project has none and none is being added.
- **Never edit `.env.local`.** The user has it open.
- **Run servers on port 3100, never 3000.** A concurrent Claude Code session works in this same repo and may hold 3000.
- **A concurrent session is actively committing to this repo.** Never `git add -A` or `git commit -a`. Stage only the files you edited, by explicit path, and run `git status --porcelain` before committing.
- **Never build in place.** `npm run build` would overwrite `.next/` under the concurrent session's dev server. Always build a clean export of the committed tree (commands given per task). This also proves the *committed* tree builds, which this repo has been burned by before.
- Verification lever — two dev-server profiles, neither touching `.env.local`:
  - **ANON** — `LOCAL_AUTHENTICATION_EMAIL="" npm run dev -- -p 3100`. `getSessionEmail()` returns `null`.
  - **SIGNED-IN** — `npm run dev -- -p 3100`. Returns `sam@polariscollective.org`.
  Both inherit `LOCAL_AUTHENTICATION_NEEDED=false`, which is what `middleware.js`'s `skipAuthInDev` requires to bypass in dev — **so middleware behaviour itself is invisible in dev and must be verified against a production build.**
- **No access-control behaviour may change except what a task explicitly specifies.** The `is_public` gate and the three endpoints' own session checks are out of scope and must not be touched.
- Exactly one run is published: `929e51a1-478d-4323-a024-02023ca910e4`, on scenario `corporate_log_consolidation_v0`. Leave it published.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `middleware.js` | Explicit `PUBLIC_PATHS` gate; anchored static-asset matcher | 1, 2 |
| `app/page.js` (was `app/compare/page.js`) | Public root: resolves session, renders the grid | 2 |
| `app/components/CompareGrid.js` (was `app/compare/CompareGrid.js`) | The compare UI | 2, 3 |
| `app/dashboard/page.js` (was `app/page.js`) | The manual runner, moved | 2, 3 |
| `next.config.mjs` | `/compare` → `/` permanent redirect | 2 |
| `app/runs/page.js`, `app/components/ScenariosList.js`, `app/layout.js` | Repointed links | 3 |
| `README.md` | Documents the new routes | 3 |

---

## Task 1: Replace the matcher gate with an explicit public-path list

Behaviour-preserving refactor of the security boundary, done first and alone so it can be reviewed without the route swap tangled into it. The one intended behaviour change is that `/favicon.icoX` and `/_next/staticfoo` become gated — today they skip middleware entirely because the matcher's exclusions are unanchored prefixes with an unescaped `.`.

**Files:**
- Modify: `middleware.js`

**Interfaces:**
- Produces: `PUBLIC_PATHS`, a module-level `Set` of exact pathnames readable without a session. Task 2 changes exactly one of its entries.

- [ ] **Step 1: Rewrite `middleware.js` below the `skipAuthInDev` constant**

Leave lines 1-18 (the imports and `skipAuthInDev` with its comment) **exactly** as they are — a concurrent session wrote that block deliberately. Replace everything from `export default auth(` to the end of the file with:

```js
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

// Four exclusions skip middleware entirely; everything else reaches the
// handler above, which makes the access decision. Each is anchored with
// (?:/|$), except favicon.ico$ which is a single file. api/auth is excluded
// HERE rather than waved through by the handler: NextAuth resolves the
// session before the callback body runs and appends any Set-Cookie to the
// response, so merely running middleware on /api/auth/* races the route's
// own cookie on the sign-in/sign-out path.
export const config = {
  matcher: ["/((?!api/auth(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$).*)"],
};
```

- [ ] **Step 2: Verify the matcher and the gate with a boundary table**

`middleware.js` short-circuits in dev, so this pure-node check is the only way to test the logic without a production build. It replicates both halves — whether the matcher runs the handler, and what `isPublicPath` then decides.

```bash
node -e '
const matcher = /^\/((?!api\/auth(?:\/|$)|_next\/static(?:\/|$)|_next\/image(?:\/|$)|favicon\.ico$).*)$/;
const PUBLIC_PATHS = new Set(["/compare", "/api/compare", "/api/runs", "/api/scenario-detail"]);
function isPublicPath(p) {
  const path = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  return PUBLIC_PATHS.has(path) || path === "/api/auth" || path.startsWith("/api/auth/");
}
// "open"   = reachable without a session
// "gated"  = middleware runs and blocks
// "skipped"= matcher excludes it, middleware never runs (static assets only)
function verdict(p) {
  if (!matcher.test(p)) return "skipped";
  return isPublicPath(p) ? "open" : "gated";
}
const cases = {
  "/compare": "open", "/compare/": "open",
  "/api/compare": "open", "/api/runs": "open", "/api/runs/": "open",
  "/api/scenario-detail": "open",
  "/api/auth": "skipped", "/api/auth/signin": "skipped", "/api/auth/callback/google": "skipped",
  "/": "gated", "/runs": "gated", "/batch": "gated", "/scenarios": "gated",
  "/api/save-run": "gated", "/api/plan": "gated", "/api/scenarios": "gated",
  "/compare/sub": "gated", "/comparex": "gated", "/compare-internal": "gated",
  "/api/comparex": "gated", "/api/runsx": "gated", "/api/scenario-detailx": "gated",
  "/api/authx": "gated", "/xcompare": "gated", "/a/compare": "gated",
  "/favicon.icoX": "gated", "/_next/staticfoo": "gated", "/_next/imagex": "gated",
  "/_next/static/chunk.js": "skipped", "/_next/image": "skipped", "/favicon.ico": "skipped",
};
let bad = 0;
for (const [p, want] of Object.entries(cases)) {
  const got = verdict(p);
  if (got !== want) { bad++; console.log("WRONG", p, "got:", got, "want:", want); }
}
console.log(bad === 0 ? "OK (" + Object.keys(cases).length + " cases)" : bad + " mismatches");'
```

Expected: `OK (31 cases)`

(Task 1 shipped with one correction found in review: `api/auth(?:/|$)` was restored to the matcher, and `_next/static` / `_next/image` anchored with `(?:/|$)` rather than a bare trailing slash — `/_next/image` is the image optimizer's real pathname and never carries one. See commit 1a8d997.)

Note `/compare/sub` is expected **gated** — exact matching deliberately does not extend to sub-paths, unlike the old `(?:/|$)` matcher. No such route exists.

- [ ] **Step 3: Verify no behaviour change against a production build**

```bash
BUILD=/private/tmp/claude-501/-Users-sverbo-Desktop-Codes-Polaris-cop-subtask-decomposition-evals/32411958-6879-4f81-ab02-c4860df57750/scratchpad/t1build
REPO="$PWD"
rm -rf "$BUILD" && mkdir -p "$BUILD"
git archive HEAD | tar -x -C "$BUILD"
ln -s "$REPO/node_modules" "$BUILD/node_modules"
cp "$REPO/.env.local" "$BUILD/.env.local"
cd "$BUILD" && npx next build 2>&1 | tail -5
cd "$BUILD" && npx next start -p 3100 > "$BUILD/prod.log" 2>&1 &
until grep -q "Ready" "$BUILD/prod.log"; do sleep 1; done
```

Do this **after** committing Step 1, so `git archive HEAD` includes it. Then:

```bash
for p in /compare /api/compare /api/runs /api/scenario-detail / /runs /batch /scenarios /api/save-run /comparex /favicon.icoX; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' "localhost:3100$p")"
done
```

Expected:

```
/compare -> 200
/api/compare -> 200
/api/runs -> 401
/api/scenario-detail -> 400
/ -> 307
/runs -> 307
/batch -> 307
/scenarios -> 307
/api/save-run -> 401
/comparex -> 307
/favicon.icoX -> 307
```

`/api/runs` is 401 from its **own** handler's list-branch check, not from middleware — that is the correct pre-existing behaviour. `/api/scenario-detail` is 400 for a missing `scenarioId`, also from its own handler. `/favicon.icoX` at 307 is the intended fix; it was previously un-gated.

**Cleanup, mandatory before reporting:** `pkill -f "next start -p 3100"` and `rm -f "$BUILD/.env.local"` — it holds real API keys.

- [ ] **Step 4: Commit**

```bash
git add middleware.js
git commit -m "Gate on an explicit public-path list instead of a matcher pattern"
```

---

## Task 2: Swap the routes

Atomic by necessity: moving the runner off `/` without moving the compare view onto it leaves a commit with no root page, and flipping `PUBLIC_PATHS` before `/` is a real page would redirect anonymous visitors to a gated root. All of it lands together.

**Files:**
- Move: `app/compare/CompareGrid.js` → `app/components/CompareGrid.js`
- Move: `app/page.js` → `app/dashboard/page.js`
- Move: `app/compare/page.js` → `app/page.js`
- Modify: `middleware.js` (one entry in `PUBLIC_PATHS`, and the page-redirect target)
- Modify: `next.config.mjs`

**Interfaces:**
- Consumes: `PUBLIC_PATHS` from Task 1.
- Produces: `/` serving `CompareGrid`; `/dashboard` serving the runner; `app/components/CompareGrid.js` as the grid's home (Task 3 edits a link inside it).

- [ ] **Step 1: Move the three files**

Order matters — `app/page.js` must vacate before `app/compare/page.js` takes its place.

```bash
git mv app/compare/CompareGrid.js app/components/CompareGrid.js
mkdir -p app/dashboard
git mv app/page.js app/dashboard/page.js
git mv app/compare/page.js app/page.js
rmdir app/compare
```

- [ ] **Step 2: Fix the moved grid's imports**

`app/components/CompareGrid.js` sits at the same depth as its old home, so only the two sibling-component imports change. Replace lines 4-5:

```js
import RunTranscriptModal from "./RunTranscriptModal";
import ScenarioDetailModal from "./ScenarioDetailModal";
```

Lines 6-7 (`../../lib/models`, `../../lib/compare-aggregate.js`) are already correct at this depth — leave them alone. Change nothing else in the file.

- [ ] **Step 3: Fix the moved runner's imports**

`app/dashboard/page.js` is one level deeper than before. Replace lines 4-6:

```js
import { MODEL_CATALOG, defaultModelFor } from "../../lib/models";
import { resolveArgs } from "../../lib/placeholders";
import { PromptViewer, AdversaryTurn, TurnBody, turnsCost } from "../components/ConversationView";
```

Line 3 (`react`) is unchanged. Change nothing else in this 962-line file.

- [ ] **Step 4: Rewrite the new root page**

`app/page.js` is now the moved compare wrapper, but at a shallower depth and pointing at a moved child. Replace the whole file with:

```js
import { getSessionEmail } from "../auth";
import CompareGrid from "./components/CompareGrid";

// The root is public — see middleware.js's PUBLIC_PATHS. This thin server
// wrapper exists only to answer one question before anything renders: is
// there a session? The grid shows a different (smaller) set of controls to a
// signed-out visitor, and resolving that on the client would mean flashing
// the signed-in UI first.
export default async function HomePage() {
  const email = await getSessionEmail();
  return <CompareGrid signedIn={Boolean(email)} />;
}
```

- [ ] **Step 5: Point `PUBLIC_PATHS` at the root, and redirect there**

In `middleware.js`, change the one entry:

```js
const PUBLIC_PATHS = new Set(["/", "/api/compare", "/api/runs", "/api/scenario-detail"]);
```

and replace the page-redirect branch at the end of the handler:

```js
  // Unauthenticated page requests land on the public root rather than the
  // sign-in screen — the banner there is the way in. This cannot loop:
  // "/" is in PUBLIC_PATHS above, so the redirect target is always let
  // through before this branch is reached.
  return NextResponse.redirect(new URL("/", req.nextUrl.origin));
```

Delete the now-unused `signInUrl` lines. Leave the `/api/` 401 branch alone.

- [ ] **Step 6: Keep `/compare` working**

Replace `next.config.mjs`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      // The compare view moved to the root when it became the public landing
      // page. Keep the old path working so existing bookmarks and links —
      // including ones already shared outside the team — don't break.
      { source: "/compare", destination: "/", permanent: true },
    ];
  },
};
export default nextConfig;
```

- [ ] **Step 7: Re-run Task 1's boundary table with the new list**

Same script as Task 1 Step 2, with `PUBLIC_PATHS` updated and the expectations for `/` and `/compare` swapped:

```bash
node -e '
const matcher = /^\/((?!api\/auth(?:\/|$)|_next\/static(?:\/|$)|_next\/image(?:\/|$)|favicon\.ico$).*)$/;
const PUBLIC_PATHS = new Set(["/", "/api/compare", "/api/runs", "/api/scenario-detail"]);
function isPublicPath(p) {
  const path = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  return PUBLIC_PATHS.has(path) || path === "/api/auth" || path.startsWith("/api/auth/");
}
function verdict(p) {
  if (!matcher.test(p)) return "skipped";
  return isPublicPath(p) ? "open" : "gated";
}
const cases = {
  "/": "open",
  "/api/compare": "open", "/api/runs": "open", "/api/runs/": "open",
  "/api/scenario-detail": "open",
  "/api/auth": "skipped", "/api/auth/signin": "skipped", "/api/auth/callback/google": "skipped",
  "/compare": "gated", "/dashboard": "gated", "/runs": "gated", "/batch": "gated",
  "/scenarios": "gated", "/scenarios/new": "gated",
  "/api/save-run": "gated", "/api/plan": "gated", "/api/scenarios": "gated",
  "/comparex": "gated", "/dashboard-internal": "gated", "/api/runsx": "gated",
  "/api/authx": "gated", "/favicon.icoX": "gated", "/_next/staticfoo": "gated",
  "/_next/imagex": "gated",
  "/_next/static/chunk.js": "skipped", "/favicon.ico": "skipped", "/_next/image": "skipped",
};
let bad = 0;
for (const [p, want] of Object.entries(cases)) {
  const got = verdict(p);
  if (got !== want) { bad++; console.log("WRONG", p, "got:", got, "want:", want); }
}
console.log(bad === 0 ? "OK (" + Object.keys(cases).length + " cases)" : bad + " mismatches");'
```

Expected: `OK (27 cases)`

`/compare` reads "gated" here and that is correct — the `next.config.mjs` redirect sends it to `/` before it ever needs to be public, and if middleware happens to run first, an anonymous visitor is redirected to `/` anyway. Same destination under either routing order.

- [ ] **Step 8: Commit, then verify against a production build**

```bash
git add middleware.js next.config.mjs app/page.js app/dashboard/page.js app/components/CompareGrid.js
git status --porcelain
git commit -m "Make the compare view the public root, and move the runner to /dashboard"
```

Confirm `git status --porcelain` shows nothing of the concurrent session's staged. Then build the committed tree exactly as in Task 1 Step 3 (using a fresh `$BUILD` path, e.g. `.../scratchpad/t2build`) and:

```bash
for p in / /dashboard /runs /batch /scenarios /api/compare /api/save-run /comparex /dashboard-internal; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' "localhost:3100$p")"
done
echo "compare redirect -> $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' 'localhost:3100/compare')"
echo "root redirects to: $(curl -s -o /dev/null -w '%{redirect_url}' 'localhost:3100/dashboard')"
```

Expected:

```
/ -> 200
/dashboard -> 307
/runs -> 307
/batch -> 307
/scenarios -> 307
/api/compare -> 200
/api/save-run -> 401
/comparex -> 307
/dashboard-internal -> 307
compare redirect -> 308 http://localhost:3100/
root redirects to: http://localhost:3100/
```

`308` is what `next.config.mjs`'s `permanent: true` emits, and Next.js applies
config redirects before middleware — so that is the expected code. A `307` to
the same `http://localhost:3100/` is also a pass: it means middleware ran
first and redirected the anonymous request itself. Either way the visitor
lands on `/`. Anything that is not a redirect to `/` is a failure.

Then confirm the root actually renders the public view:

```bash
curl -s localhost:3100/ | grep -o "Viewing public results\|Plan+execute vs. chained" | sort -u
```

Expected: both strings present.

**Cleanup, mandatory:** kill the server and `rm -f "$BUILD/.env.local"`.

---

## Task 3: Repoint internal links and the README

**Files:**
- Modify: `app/components/CompareGrid.js`, `app/dashboard/page.js`, `app/runs/page.js`, `app/components/ScenariosList.js`, `app/layout.js`, `README.md`

- [ ] **Step 1: The grid's "back" link**

In `app/components/CompareGrid.js`, the signed-in header block has `<a href="/" …>← Back to dashboard</a>`. Change the href to `/dashboard`. Leave the label and the `signedIn &&` gate as they are.

- [ ] **Step 2: The runner's link to compare**

In `app/dashboard/page.js`, change `<a className="btn btn-ghost" href="/compare">` to `href="/"`. If the link's label says "compare", leave the wording alone — it still goes to the compare view.

- [ ] **Step 3: The runs table's three links**

In `app/runs/page.js`:
- `<a href="/compare" …>` → `href="/"`
- `<a href="/" …>` (the "back to dashboard" one) → `href="/dashboard"`
- the **Open** button, `` href={`/?id=${encodeURIComponent(r.id)}`} `` → `` href={`/dashboard?id=${encodeURIComponent(r.id)}`} ``

- [ ] **Step 4: The scenarios list link**

In `app/components/ScenariosList.js`, `<a href="/" …>` → `href="/dashboard"`.

- [ ] **Step 5: The sign-in callback**

In `app/layout.js`, change `href="/api/auth/signin?callbackUrl=%2Fcompare"` to `href="/api/auth/signin?callbackUrl=%2F"`. Signing in from the public root leaves you on the root, which then shows every run rather than only published ones.

Leave `signOut({ redirectTo: "/" })` as it is — landing on the public view after signing out is correct, and it is now a page that renders for a signed-out user.

- [ ] **Step 6: The README**

Three edits.

**1.** `README.md:141` — "opens it in the dashboard at `/?id=<id>`" → `/dashboard?id=<id>`.

**2.** In the `### The public compare view` subsection, replace the opening sentence. Currently:

```markdown
`/compare` is readable without signing in, but only shows runs whose
`is_public` column is `true`. Nothing in the app ever writes that column —
```

becomes:

```markdown
The site root `/` is the public compare view: readable without signing in,
but showing only runs whose `is_public` column is `true`. It is the only
page reachable signed out — every other page redirects there rather than to
a sign-in screen — and the manual runner it replaced now lives at
`/dashboard`. The old `/compare` path permanently redirects to `/`. Nothing
in the app ever writes the `is_public` column —
```

**3.** In the same subsection, the closing sentence says `middleware.js` "carves them out of the sign-in gate on that basis". That description is now wrong — the gate is an explicit list, not a carve-out. Replace:

```markdown
themselves; `middleware.js` carves them out of the sign-in gate on that basis.
```

with:

```markdown
themselves; `middleware.js` lists them, and `/`, in its `PUBLIC_PATHS` set on
that basis.
```

Then scan for anything else stale with `grep -n "compare\|/?id=" README.md` and fix only what is genuinely wrong. The line "Open http://localhost:3000" near the top now lands on the public view rather than the runner — worth a short parenthetical pointing at `/dashboard`. Do not rewrite sections that are merely adjacent.

- [ ] **Step 7: Verify the links**

```bash
grep -rn 'href="/"\|href="/compare"\|href={`/?id=' app/ --include="*.js"
```

Expected: no matches for `href="/compare"`; no `` href={`/?id= ``. The only remaining bare `href="/"` should be none — every one has become `/dashboard` or stayed as a deliberate root link. Report exactly what remains and why.

Then start the dev server in the **SIGNED-IN** profile and confirm each page still returns 200:

```bash
for p in / /dashboard /runs /batch /scenarios; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' "localhost:3100$p")"
done
echo "deep link -> $(curl -s -o /dev/null -w '%{http_code}' 'localhost:3100/dashboard?id=929e51a1-478d-4323-a024-02023ca910e4')"
```

Expected: all `200`.

Kill the server before reporting.

- [ ] **Step 8: Commit**

```bash
git add app/components/CompareGrid.js app/dashboard/page.js app/runs/page.js app/components/ScenariosList.js app/layout.js README.md
git status --porcelain
git commit -m "Repoint links at the new root and /dashboard"
```

---

## Human verification (controller arranges; not a subagent task)

Anonymous, in a browser:
1. `/` renders the compare grid with the "Viewing public results" bar and the "Public runs only" chip.
2. `/dashboard`, `/runs`, `/batch`, `/scenarios` each land you on `/` rather than a sign-in screen.
3. `/compare` lands on `/`.
4. Clicking **Sign in** completes and returns you to `/`, now showing every run.

Signed in:
5. `/` shows the full grid plus `Public only (1)`; the header's "← Back to dashboard" goes to `/dashboard`.
6. `/dashboard` is the manual runner, working as before.
7. `/runs` → **Open** on any row loads that run in `/dashboard`.
