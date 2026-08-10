# Public root route — design

Date: 2026-08-10

## Problem

The public compare view lives at `/compare`, while `/` is the signed-in
manual runner. That is backwards for the audience the public view exists to
serve: the one page an outsider may read sits at a secondary path, and the
root — the URL anyone types first — bounces them to a sign-in screen.

Three changes:

1. `/` becomes the public compare view. It is the only page reachable without
   signing in.
2. The manual runner moves to `/dashboard`, unchanged.
3. An unauthenticated request for a gated **page** redirects to `/` rather
   than to the sign-in screen. The banner on `/` is the way in.

Builds on `2026-08-10-public-compare-view-design.md`, which established the
`runs.is_public` flag and the three anonymously-readable endpoints. None of
that access-control logic changes here — only which URL the public view
occupies, and where unauthenticated visitors land.

## Non-goals

- No change to what anonymous visitors can *see*. The `is_public` gate, the
  three endpoint checks, and the signed-out UI are all untouched.
- No change to the manual runner itself. It moves; it does not change.
- No "sign in and return to where you were" plumbing. Every unauthenticated
  page request lands on `/`, full stop.

## Routes

| Path | What | Access |
|---|---|---|
| `/` | the compare view | public |
| `/dashboard` | the manual runner, moved verbatim | gated |
| `/compare` | permanent redirect to `/` | — |
| `/runs`, `/batch`, `/scenarios/*` | unchanged | gated |
| `/api/compare`, `/api/runs`, `/api/scenario-detail` | unchanged | public, each self-gating |
| every other `/api/*` | unchanged | gated, 401 |

`/compare` stays alive as a redirect rather than being deleted: it costs three
lines in `next.config.mjs` and keeps existing bookmarks and the README's older
references working. The redirect is correct under either routing order — if
`next.config` redirects run before middleware, an anonymous visitor is sent to
`/`, which is public; if middleware runs first, `/compare` is not in the public
list, so an anonymous visitor is redirected to `/` anyway. Same destination
either way.

## File moves

- `app/page.js` → `app/dashboard/page.js`, content unchanged.
- `app/compare/CompareGrid.js` → `app/components/CompareGrid.js`, content
  unchanged. That is where this repo already keeps its large client components
  (`RunTranscriptModal`, `ScenarioDetailModal`, `ScenariosList`, …).
- `app/compare/page.js` → `app/page.js`, with its `CompareGrid` import
  repointed.
- The `app/compare/` directory is removed.

## Middleware: invert the gate

Today the gate is a single negative-lookahead regex in `config.matcher`.
Adding `/` to it means expressing "the empty path, at end of string" inside
that lookahead — and this is exactly the construct that has already produced
two defects in this repo: the `api/auth` prefix bug that was found and fixed
in review, and the `_next/static` / `_next/image` / `favicon.ico` entries
which are **still** unanchored today (`/favicon.icoX` and `/_next/staticfoo`
currently bypass the gate; not exploitable, since no route resolves there, but
live).

So the matcher becomes broad and the decision moves into the handler, against
an explicit list:

```js
// Exact paths readable without a session. A Set of exact strings, not a
// pattern: the previous negative-lookahead matcher produced two separate
// path-boundary defects, and every one of them was a case where a string
// that merely *started* with a public path was treated as public. Exact
// matching cannot express that bug.
const PUBLIC_PATHS = new Set(["/", "/api/compare", "/api/runs", "/api/scenario-detail"]);
```

with a prefix check for `/api/auth/` (Auth.js's own endpoints, which genuinely
are a subtree). The pathname is normalised by stripping a single trailing
slash before the lookup — but only when the path is longer than `/`, so the
root does not normalise to the empty string.

The matcher itself keeps only the static-asset exclusions, since those are
about not running middleware needlessly rather than about access, and there is
no longer any reason for it to know about `/api/auth`:

```js
matcher: ["/((?!_next/static/|_next/image/|favicon\\.ico$).*)"]
```

Those three are **anchored** — `_next/static/` and `_next/image/` with a
trailing slash, `favicon\.ico` with `$` and an escaped dot. That is what
actually closes the outstanding finding: today `/favicon.icoX` and
`/_next/staticfoo` skip middleware entirely because those alternatives are
unanchored prefixes with an unescaped `.`. Inverting the gate does not fix
that on its own — the matcher decides whether the handler runs at all — so it
has to be fixed here explicitly.

Neither `/compare` nor `/dashboard` appears in `PUBLIC_PATHS`, and no
`startsWith` is used for them, so no sibling path (`/comparex`,
`/dashboard-internal`) can inherit public access.

## Unauthenticated redirect

The handler's page branch changes from:

```js
const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
signInUrl.searchParams.set("callbackUrl", req.nextUrl.href);
return NextResponse.redirect(signInUrl);
```

to a redirect to `/`. The API branch keeps its 401 unchanged.

Consequence, accepted deliberately: a team member who deep-links to
`/dashboard?id=<run>` while signed out loses that destination — they land on
`/`, sign in from the banner, and navigate again. The alternative (threading
the original URL through as a query parameter) is the plumbing this change
exists to remove.

`app/layout.js`'s signed-out **Sign in** link keeps a `callbackUrl`, now
pointing at `/` rather than `/compare`: signing in from the public page leaves
you where you are, and the same page then shows you everything instead of only
published runs.

`signOut` keeps `redirectTo: "/"` — landing on the public view after signing
out is correct, and it is now a page that actually renders for a signed-out
user rather than a redirect to the sign-in screen.

## Links to update

| File | Now | Becomes |
|---|---|---|
| `app/components/CompareGrid.js` | `href="/"` ("← Back to dashboard") | `/dashboard` |
| `app/dashboard/page.js` | `href="/compare"` | `/` |
| `app/runs/page.js` | `href="/compare"` | `/` |
| `app/runs/page.js` | `href="/"` | `/dashboard` |
| `app/runs/page.js` | `` href={`/?id=${id}`} `` (the **Open** button) | `` `/dashboard?id=${id}` `` |
| `app/components/ScenariosList.js` | `href="/"` | `/dashboard` |
| `app/layout.js` | `signin?callbackUrl=%2Fcompare` | `%2F` |
| `README.md` | `/?id=<id>` | `/dashboard?id=<id>` |

The moved runner reads its `?id=` from `window.location.search`, so it keeps
working at the new path with no code change. No batch script emits a URL, so
`summary.csv` is unaffected.

## Edge cases

- **Trailing slashes.** `/api/runs/` normalises to `/api/runs` before the
  public-path lookup.
- **A future sub-route under a public path.** `app/api/runs/foo/route.js`
  would NOT be public under exact matching — the opposite of the old
  behaviour, and the safer default. Worth a comment so the next person knows
  they must add it explicitly.
- **Signed-out visitor at `/compare`.** Redirected to `/` under either
  routing order, as above.

## Verification

Manual, against a production build of the committed tree (`git archive HEAD`
into a clean directory, then `next build` and `next start`) — this project has
no test framework and none is being added.

Anonymous:

| Path | Expected |
|---|---|
| `/` | 200, renders the compare grid and the "Viewing public results" bar |
| `/dashboard` | 307 → `/` |
| `/runs`, `/batch`, `/scenarios` | 307 → `/` |
| `/compare` | redirect to `/` |
| `/api/compare` | 200 |
| `/api/save-run`, `/api/plan` | 401 |
| `/comparex`, `/dashboard-internal` | 307 → `/` (no sibling leakage) |
| `/favicon.icoX` | gated now, where it previously was not |

Signed in: `/`, `/dashboard`, `/runs`, `/batch`, `/scenarios` all 200, and
`/dashboard?id=<run-id>` loads that run.
