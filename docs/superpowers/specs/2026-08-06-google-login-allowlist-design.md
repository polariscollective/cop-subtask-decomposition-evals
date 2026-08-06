# Google login + allowlist — design

## Purpose

The app is deployed on Vercel at a public URL, calling Anthropic/OpenAI with
API keys that live server-side only (`lib/anthropic.js`, `lib/providers.js`,
never sent to the browser). Right now anyone who finds the URL can use it,
which means anyone can spend against those keys. This adds a login gate so
only a small, explicitly-approved set of people (a couple of colleagues, a
couple of people at an external company) can reach the app at all — access
control, not per-user billing. The owner's keys keep paying for all
authorized usage, unchanged from today.

Bring-your-own-key was considered and rejected: this app is being shared with
a small trusted group, not opened to the public, so gating access is enough —
no need for each person to supply their own key, and no need to ever put an
API key in the browser.

## Approach

**Auth.js (NextAuth v5) with the Google provider.** Rejected alternatives:
- Hand-rolled Google OAuth (manual cookie signing, CSRF, token refresh) —
  more security-sensitive code to get right for no benefit over a
  well-audited library.
- Hosted auth (Clerk, Auth0) — an external account/service to manage, and a
  nicer allowlist UI than plain env vars isn't needed at this scale.

Session strategy: JWT (Auth.js default when there's no database configured).
No database, no extra network call per request to validate a session — just
a local signature check on the session cookie.

## Allowlist

Two new env vars, comma-separated, checked in the Auth.js `signIn` callback:

```
ALLOWED_EMAILS=someone@gmail.com,other@external.com
ALLOWED_DOMAINS=polariscollective.org
```

A sign-in is allowed if the Google account's email exactly matches an entry
in `ALLOWED_EMAILS`, OR its domain (the part after `@`) matches an entry in
`ALLOWED_DOMAINS`. Otherwise the `signIn` callback returns `false`, which
Auth.js turns into an immediate rejection — the person never reaches the app,
they land back on a generic Auth.js error screen. No separate
"account not authorized" page is built for this.

## Route protection

`middleware.js` at the project root, matching everything except
`app/api/auth/*` (which must stay reachable — it's what serves the Google
sign-in flow itself) and static assets:

- **Page routes** (`/`): no valid session → redirect to Google sign-in.
- **API routes** (`app/api/*` other than `app/api/auth/*`): no valid session
  → return `401` directly. Never a redirect here — a redirect response would
  either be misread as the answer by a `fetch(...).then(r => r.json())` call
  from the frontend (breaking on the redirect target's HTML instead of
  throwing a clear error), or let a direct `curl` against the API through
  with a 200-looking response. The route handler in `app/api/plan/route.js`
  etc. never executes for an unauthenticated request — the block happens in
  middleware, before any Anthropic/OpenAI call is made.

This means every existing API route (`plan`, `execute-step`, `ask-direct`,
`save-run`, `scenario-detail`, `scenarios`) is protected automatically by the
middleware matcher — no per-route changes needed inside those files.

## UI changes

`app/layout.js` (or a small header in `app/page.js`) gains a "Signed in as
`<email>` — Sign out" line, sourced from the Auth.js session. This is the
only addition to the existing UI; nothing else in `app/page.js` changes.

## Environment variables (Vercel project settings, no `NEXT_PUBLIC_` prefix)

- `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` — from a new Google OAuth 2.0 Client
  ID, created by hand in the `polaris-dev` GCP project (Google Cloud
  Console — OAuth client creation isn't Terraform-managed, see
  `polaris-tf/README.md`; this app isn't part of the GCP/Cloud Run
  Terraform-managed set at all, it's Vercel-hosted). A **new** client is
  created rather than reusing `mission-control`'s, so the two apps don't
  share a secret or a blast radius.
- `AUTH_SECRET` — random value Auth.js uses to sign session JWTs.
- `ALLOWED_EMAILS`, `ALLOWED_DOMAINS` — as above.

Existing `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars are unchanged.

## Testing plan

Manual verification after deploy (no automated test suite exists in this
project today):
1. Visiting `/` while signed out redirects to Google sign-in.
2. Signing in with an email in `ALLOWED_EMAILS` (or a domain in
   `ALLOWED_DOMAINS`) reaches the app.
3. Signing in with a Google account matching neither lands on the Auth.js
   error screen, not the app.
4. `curl` (no session cookie) against `/api/plan` and `/api/scenarios`
   returns `401`, not a redirect and not a 200.
5. "Sign out" clears the session and the next page load redirects to sign-in
   again.

## Out of scope

- Bring-your-own-key.
- Per-user roles or permissions — every allowlisted account has identical
  access.
- An admin UI for managing the allowlist — it's edited directly in Vercel
  project settings.
