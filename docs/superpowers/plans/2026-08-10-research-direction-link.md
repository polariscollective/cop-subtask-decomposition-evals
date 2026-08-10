# Research Direction Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conditionally add a configured research-direction document link to the signed-out public preview banner.

**Architecture:** Read `RESEARCH_DIRECTION_URL` in the root server component and pass it into the existing client comparison component. Render the More info paragraph only when that prop is non-empty, and document the optional deployment variable in `.env.example`.

**Tech Stack:** Next.js 14 App Router, React 18, environment variables.

## Global Constraints

- Use `RESEARCH_DIRECTION_URL`; do not expose a `NEXT_PUBLIC_*` variable.
- Render `More info: Information about the research direction` only inside the existing signed-out banner.
- Render nothing when the variable is missing or empty.
- Open the configured link in the current tab.
- Do not add UI tests, per the user's explicit request.
- Do not change routing, middleware, APIs, authentication, or result data.

---

### Task 1: Wire and render the optional research link

**Files:**
- Modify: `.env.example`
- Modify: `app/page.js`
- Modify: `app/components/CompareGrid.js`

**Interfaces:**
- Consumes: `process.env.RESEARCH_DIRECTION_URL` on the server.
- Produces: `CompareGrid({ signedIn, researchDirectionUrl })` and a conditional anchor inside `.cmp-preview-banner`.

- [ ] **Step 1: Document the optional variable**

Add this to `.env.example` beneath the storage/configuration section:

```dotenv
# Optional public document explaining the project's research direction.
RESEARCH_DIRECTION_URL=
```

- [ ] **Step 2: Pass the variable from the server component**

Update `HomePage` in `app/page.js`:

```jsx
export default async function HomePage() {
  const email = await getSessionEmail();
  const researchDirectionUrl = process.env.RESEARCH_DIRECTION_URL?.trim() || null;
  return <CompareGrid signedIn={Boolean(email)} researchDirectionUrl={researchDirectionUrl} />;
}
```

- [ ] **Step 3: Render the conditional link**

Accept `researchDirectionUrl` in `CompareGrid`. After the feedback paragraph and still inside the existing signed-out banner, add:

```jsx
{researchDirectionUrl && (
  <p>
    <strong>More info:</strong>{" "}
    <a href={researchDirectionUrl}>Information about the research direction</a>
  </p>
)}
```

- [ ] **Step 4: Verify without UI tests**

Run:

```bash
npm run build
git diff --check
```

Expected: the production build succeeds and the diff check emits no output. Inspect the JSX to confirm the conditional is nested inside `!signedIn`, so both the missing-variable and authenticated cases omit it structurally.

- [ ] **Step 5: Commit**

```bash
git add .env.example app/page.js app/components/CompareGrid.js docs/superpowers/plans/2026-08-10-research-direction-link.md
git commit -m "Add optional research direction link"
```
