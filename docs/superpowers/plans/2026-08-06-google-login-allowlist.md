# Google login + allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the whole app (pages and API routes) behind Google sign-in, restricted to an allowlist of exact emails and/or email domains, so only approved people can spend against the owner's Anthropic/OpenAI keys.

**Architecture:** Auth.js (NextAuth v5) with the Google provider, JWT sessions (no database). A `signIn` callback rejects any Google account not on the allowlist. A root `middleware.js` protects every route: page requests without a session redirect to Google sign-in, API requests without a session get a `401` directly, before any route handler (and therefore before any Anthropic/OpenAI call) runs.

**Tech Stack:** Next.js 14.2.35 (App Router), `next-auth@5.0.0-beta.32` (Auth.js), deployed on Vercel.

## Global Constraints

- Session strategy is JWT only — no database, no adapter, no extra network call per request to validate a session.
- Unauthenticated API requests (`app/api/*` except `app/api/auth/*`) must get a `401` JSON response, never a redirect.
- No new env var may use the `NEXT_PUBLIC_` prefix — none of this is meant to reach the browser.
- The Google OAuth Client must be a **new** client in the `polaris-dev` GCP project, not a reuse of `mission-control`'s.
- Existing `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` handling in `lib/anthropic.js` / `lib/providers.js` is unchanged.
- Out of scope, do not build: bring-your-own-key, per-user roles/permissions, an admin UI for the allowlist.
- This project has no automated test framework (`package.json` has no test script or test dependency) — every task verifies behavior manually via `npm run dev` plus `curl`/browser, matching the existing project convention. Do not introduce a test framework as a side effect of this feature.

---

### Task 1: Create the Google OAuth Client and local env vars

**Files:**
- Modify: `.env.local` (gitignored, not committed — created by copying `.env.example`)

**Interfaces:**
- Produces: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `ALLOWED_EMAILS`, `ALLOWED_DOMAINS` env vars, consumed by `auth.js` in Task 2.

- [ ] **Step 1: Create the OAuth consent screen (if not already configured in `polaris-dev`)**

  In the Google Cloud Console, with the `polaris-dev` project (`polaris-dev-499213`) selected:
  `APIs & Services` → `OAuth consent screen`. If one already exists for this project (e.g. from `mission-control`), skip this step — consent screens are project-wide, not per-client.

- [ ] **Step 2: Create a new OAuth 2.0 Client ID**

  `APIs & Services` → `Credentials` → `Create Credentials` → `OAuth client ID`.
  - Application type: `Web application`
  - Name: `cop-subtask-decomposition-evals` (so it's identifiable as separate from `mission-control` in the credentials list)
  - Authorized redirect URIs: add both
    - `http://localhost:3000/api/auth/callback/google`
    - the production Vercel URL once known, e.g. `https://<your-vercel-app>.vercel.app/api/auth/callback/google`

  Save. Copy the generated **Client ID** and **Client secret** — you'll need them in Step 4.

- [ ] **Step 3: Copy `.env.example` to `.env.local` if you haven't already**

  ```bash
  cp .env.example .env.local
  ```

  (Skip if `.env.local` already exists — it's gitignored, so this won't overwrite real keys already in it if the file is already present; just add the new lines from Step 4 to the existing file.)

- [ ] **Step 4: Add the new env vars to `.env.local`**

  Append these lines (replace the placeholder values with your actual data):

  ```
  AUTH_GOOGLE_ID=<client id from step 2>
  AUTH_GOOGLE_SECRET=<client secret from step 2>
  AUTH_SECRET=<output of: openssl rand -base64 33>
  ALLOWED_EMAILS=<your own Google account email, for testing>
  ALLOWED_DOMAINS=
  ```

  Generate `AUTH_SECRET` with:

  ```bash
  openssl rand -base64 33
  ```

- [ ] **Step 5: Verify the file is not tracked by git**

  ```bash
  git status --short .env.local
  ```

  Expected: no output (the file is gitignored, per the existing `.gitignore` entry for `.env.local`).

---

### Task 2: Install next-auth and create the Auth.js config

**Files:**
- Modify: `package.json` (add `next-auth` dependency)
- Create: `auth.js` (project root, alongside `next.config.mjs`)

**Interfaces:**
- Consumes: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `ALLOWED_EMAILS`, `ALLOWED_DOMAINS` from `.env.local` (Task 1).
- Produces: named exports `GET`, `POST`, `auth`, `signIn`, `signOut` from `auth.js`, consumed by Task 3 (route handler) and Task 4 (middleware) and Task 5 (layout UI).

- [ ] **Step 1: Install `next-auth`**

  ```bash
  npm install next-auth@beta
  ```

  This installs `next-auth@5.0.0-beta.32` (or newer 5.x beta) and adds it to `package.json` dependencies.

- [ ] **Step 2: Create `auth.js`**

  ```js
  import NextAuth from "next-auth";
  import Google from "next-auth/providers/google";

  function parseList(envVar) {
    return (envVar || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  const allowedEmails = parseList(process.env.ALLOWED_EMAILS);
  const allowedDomains = parseList(process.env.ALLOWED_DOMAINS);

  export const {
    handlers: { GET, POST },
    auth,
    signIn,
    signOut,
  } = NextAuth({
    providers: [Google],
    callbacks: {
      async signIn({ user }) {
        const email = (user.email || "").toLowerCase();
        if (!email) return false;
        if (allowedEmails.includes(email)) return true;
        const domain = email.split("@")[1];
        return Boolean(domain && allowedDomains.includes(domain));
      },
    },
  });
  ```

  Destructuring `handlers` into `GET`/`POST` here (rather than exporting
  `handlers` itself) is what lets Task 3's route file do
  `export { GET, POST } from "../../../../auth"`.

  `Google` with no explicit `clientId`/`clientSecret` reads `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` automatically — this is Auth.js v5's default env var naming convention for the `google` provider.

- [ ] **Step 3: Confirm the file has no syntax errors**

  ```bash
  node --check auth.js
  ```

  Expected: no output (exit code 0). This only checks syntax — `auth.js` can't be meaningfully run standalone yet since it depends on Next.js's request context; real verification happens in Task 3.

- [ ] **Step 4: Commit**

  ```bash
  git add package.json package-lock.json auth.js
  git commit -m "$(cat <<'EOF'
  Add Auth.js config with Google provider and email/domain allowlist

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 3: Wire up the Auth.js API route

**Files:**
- Create: `app/api/auth/[...nextauth]/route.js`

**Interfaces:**
- Consumes: `GET`, `POST` from `auth.js` (Task 2).

- [ ] **Step 1: Create the route handler**

  ```js
  export { GET, POST } from "../../../../auth";
  ```

- [ ] **Step 2: Start the dev server**

  ```bash
  npm run dev
  ```

- [ ] **Step 3: Verify the sign-in page loads**

  Open `http://localhost:3000/api/auth/signin` in a browser.
  Expected: Auth.js's default sign-in page, showing a "Sign in with Google" button.

- [ ] **Step 4: Verify a full sign-in with an allowed account**

  Click "Sign in with Google" and complete the flow using the Google account you put in `ALLOWED_EMAILS` in Task 1.
  Expected: redirected back to `http://localhost:3000/` (the app's home page — no visible change yet, that's Task 5).

- [ ] **Step 5: Verify rejection for a non-allowed account**

  Sign out (open `http://localhost:3000/api/auth/signout`, confirm), then sign in again using a *different* Google account not on the allowlist (or temporarily edit `ALLOWED_EMAILS` in `.env.local` to remove your account, restart `npm run dev`, sign in, then restore it afterward).
  Expected: redirected to `http://localhost:3000/api/auth/error?error=AccessDenied` — not the app.

- [ ] **Step 6: Commit**

  ```bash
  git add app/api/auth
  git commit -m "$(cat <<'EOF'
  Wire up Auth.js route handler at /api/auth/*

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: Add middleware to protect pages and API routes

**Files:**
- Create: `middleware.js` (project root, alongside `auth.js`)

**Interfaces:**
- Consumes: `auth` from `auth.js` (Task 2).

- [ ] **Step 1: Create `middleware.js`**

  ```js
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
    matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
  };
  ```

  The matcher excludes `/api/auth/*` (must stay reachable — it's the sign-in/callback flow itself), Next's static asset paths, and the favicon. Everything else — `/` and every other `/api/*` route — goes through the check above.

- [ ] **Step 2: Restart the dev server**

  ```bash
  # Ctrl+C the running npm run dev, then:
  npm run dev
  ```

- [ ] **Step 3: Verify an unauthenticated page request redirects**

  Sign out (`http://localhost:3000/api/auth/signout`), then open `http://localhost:3000/` in the browser.
  Expected: redirected to `http://localhost:3000/api/auth/signin?callbackUrl=...`.

- [ ] **Step 4: Verify an unauthenticated API request gets a 401, not a redirect**

  ```bash
  curl -i http://localhost:3000/api/scenarios
  ```

  Expected: `HTTP/1.1 401 Unauthorized` with body `{"error":"Unauthorized"}` — no `Location` header, no HTML.

- [ ] **Step 5: Verify an authenticated session reaches both pages and the API**

  Sign in with an allowed account in the browser, then in the same browser open `http://localhost:3000/` — expected: the app loads normally. The `curl` check in Step 4 will still show `401` since `curl` doesn't carry the browser's session cookie — that's expected, not a bug.

- [ ] **Step 6: Commit**

  ```bash
  git add middleware.js
  git commit -m "$(cat <<'EOF'
  Protect all routes with Auth.js middleware (401 for API, redirect for pages)

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 5: Show signed-in state and a sign-out control

**Files:**
- Modify: `app/layout.js`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `auth`, `signOut` from `auth.js` (Task 2).

- [ ] **Step 1: Update `app/layout.js`**

  ```js
  import "./globals.css";
  import { auth, signOut } from "../auth";

  export const metadata = {
    title: "Decomposition scenario runner",
  };

  export default async function RootLayout({ children }) {
    const session = await auth();

    return (
      <html lang="en">
        <body>
          {session?.user && (
            <div className="auth-bar">
              <span>Signed in as {session.user.email}</span>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <button type="submit" className="btn btn-ghost">
                  Sign out
                </button>
              </form>
            </div>
          )}
          {children}
        </body>
      </html>
    );
  }
  ```

- [ ] **Step 2: Add `.auth-bar` styling to `app/globals.css`**

  Add this block after the existing `.app-subtitle` rule (around line 51):

  ```css
  .auth-bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    padding: 10px 24px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--muted);
  }
  ```

- [ ] **Step 3: Restart the dev server and verify visually**

  ```bash
  # Ctrl+C the running npm run dev, then:
  npm run dev
  ```

  Sign in with an allowed account at `http://localhost:3000/`.
  Expected: a bar at the top of the page reading "Signed in as `<your email>` [Sign out]".

- [ ] **Step 4: Verify sign-out works**

  Click "Sign out".
  Expected: redirected to `/`, then immediately redirected again to the Google sign-in page (Task 4's middleware kicking in now that there's no session) — the auth bar is gone.

- [ ] **Step 5: Commit**

  ```bash
  git add app/layout.js app/globals.css
  git commit -m "$(cat <<'EOF'
  Show signed-in email and a sign-out control in the app header

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: Document the new env vars and run the full verification checklist

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Update `.env.example`**

  Current content:
  ```
  # Copy this file to .env.local and fill in your key.
  # .env.local is gitignored by default in Next.js, never commit real keys.
  ANTHROPIC_API_KEY=sk-ant-...
  ```

  Replace with:
  ```
  # Copy this file to .env.local and fill in your keys.
  # .env.local is gitignored by default in Next.js, never commit real keys.
  ANTHROPIC_API_KEY=sk-ant-...
  OPENAI_API_KEY=sk-...

  # Google sign-in (see README for how to create these) — restricts who can
  # reach the app at all, everyone allowed shares the keys above.
  AUTH_GOOGLE_ID=
  AUTH_GOOGLE_SECRET=
  AUTH_SECRET=
  ALLOWED_EMAILS=
  ALLOWED_DOMAINS=
  ```

- [ ] **Step 2: Add a "Login" section to `README.md`**

  Insert this new section right after the "Two ways to run it" section's closing (after the line ending "...even after one succeeds, to get a full comparison — there's no "stop at first success" mode.", i.e. at the end of the file, before EOF):

  ```markdown

  ## Login

  The app is gated behind Google sign-in — only accounts in `ALLOWED_EMAILS`
  (exact match) or with a domain in `ALLOWED_DOMAINS` can reach it. Everyone
  who's allowed in shares the `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set in
  the environment; there's no per-user key.

  To set up a new environment (local or a new Vercel project):
  1. Create an OAuth 2.0 Client ID in the Google Cloud Console (`polaris-dev`
     project), with an authorized redirect URI of
     `<your-deployment-url>/api/auth/callback/google`.
  2. Set `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` from that client.
  3. Set `AUTH_SECRET` to the output of `openssl rand -base64 33`.
  4. Set `ALLOWED_EMAILS` and/or `ALLOWED_DOMAINS` (comma-separated) to
     whoever should have access.

  On Vercel, add these as project environment variables (not prefixed with
  `NEXT_PUBLIC_`, so they stay server-side) rather than in a committed file.
  ```

- [ ] **Step 3: Run the full verification checklist from the spec**

  With `npm run dev` running and `.env.local` fully populated (Task 1):

  1. `curl -i http://localhost:3000/` while signed out → redirects (`307`/`308`) toward `/api/auth/signin`.
  2. Sign in with an email from `ALLOWED_EMAILS` → app loads.
  3. Temporarily add a second Google account's domain to `ALLOWED_DOMAINS`, sign in with an account on that domain → app loads. Revert `ALLOWED_DOMAINS` afterward if it was test-only.
  4. Sign in with a Google account matching neither `ALLOWED_EMAILS` nor `ALLOWED_DOMAINS` → lands on `/api/auth/error?error=AccessDenied`, not the app.
  5. `curl -i http://localhost:3000/api/plan -X POST -H "Content-Type: application/json" -d '{}'` (no session cookie) → `401`, not a redirect, not a 200.
  6. Sign in, click "Sign out" → auth bar disappears, next page load redirects to sign-in again.

  All six must pass before considering this done.

- [ ] **Step 4: Commit**

  ```bash
  git add .env.example README.md
  git commit -m "$(cat <<'EOF'
  Document Google login setup and env vars in README

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Deployment note (not part of this plan's tasks)

Once merged, the same env vars (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`,
`AUTH_SECRET`, `ALLOWED_EMAILS`, `ALLOWED_DOMAINS`) need to be added to the
Vercel project's environment variables, and the production callback URL
(`https://<app>.vercel.app/api/auth/callback/google`) needs to be added to
the same Google OAuth client's authorized redirect URIs from Task 1. This is
a manual dashboard step the project owner does at deploy time, not something
to automate here.
