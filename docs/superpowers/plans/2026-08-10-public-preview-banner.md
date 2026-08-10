# Public Preview Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Label the signed-out root page as a non-statistical early preview and make each available scenario heading clearly open the existing detail modal.

**Architecture:** Keep the canonical `/` route and all data/access logic unchanged. Add signed-out-only presentational markup to `CompareGrid`, replace its custom keyboard-emulated clickable heading with a native button, and add scoped styles in the existing global stylesheet.

**Tech Stack:** Next.js 14 App Router, React 18, existing global CSS, Node test runner, Next production build.

## Global Constraints

- The preview banner appears only when `signedIn` is false.
- Use the exact approved English copy from `docs/superpowers/specs/2026-08-10-public-preview-banner-design.md`.
- The contact is a `mailto:sam@polariscollective.org` link.
- The scenario title and `Click here for more details` form one native button and open the existing `ScenarioDetailModal`.
- A scenario without accessible details remains a non-interactive heading and does not show a false call to action.
- Do not change `/`, `/compare`, middleware, APIs, public-record filtering, or result calculations.
- Do not add dependencies or a new styling system.

---

### Task 1: Public preview banner and scenario affordance

**Files:**
- Modify: `app/components/CompareGrid.js`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `CompareGrid({ signedIn: boolean })`, existing `detailScenario` state, and `ScenarioDetailModal`.
- Produces: signed-out-only `.cmp-preview-banner` markup and a `.cmp-scenario-trigger` button that calls `setDetailScenario({ id, title })`.

- [ ] **Step 1: Establish the failing behavior check**

Run the current app and inspect `/` signed out. Confirm these expected failures before editing:

1. No `Work in progress` banner is present.
2. An available scenario heading does not contain `Click here for more details`.
3. The heading uses `role="button"` keyboard emulation rather than a native button.

Run:

```bash
npm run dev
```

Expected: all three feature checks fail on the current page. This repository has no React DOM test harness, so this task uses the real rendered Next.js page for the red/green interaction check rather than adding a dependency for one presentational change.

- [ ] **Step 2: Add the signed-out banner**

In `CompareGrid`, immediately after the page-heading row and before error/loading content, render the following only under `!signedIn`:

```jsx
<aside className="cmp-preview-banner" aria-labelledby="preview-banner-title">
  <div className="cmp-preview-kicker" id="preview-banner-title">
    Work in progress
  </div>
  <p>
    This is an early preview intended to show the direction this project could take. It currently
    includes only a few models, a limited selection of argumentation styles, and two example
    scenarios that have not yet been fully validated. No statistically significant results or
    conclusions are presented here yet, and several aspects of the results display still need
    improvement.
  </p>
  <p>
    For feedback—or to request internal access to experiment with scenario generation and
    evaluation runs—feel free to contact{" "}
    <a href="mailto:sam@polariscollective.org">sam@polariscollective.org</a>.
  </p>
</aside>
```

- [ ] **Step 3: Replace keyboard emulation with a native scenario button**

For `canOpen` scenarios, keep the `h2` and move interaction into one button:

```jsx
<h2 className="cmp-scenario-title">
  <button
    type="button"
    className="cmp-scenario-trigger"
    onClick={() => setDetailScenario({ id: scenario.id, title: scenario.title })}
  >
    <span>{scenario.title}</span>
    <span className="cmp-scenario-hint">Click here for more details</span>
  </button>
</h2>
```

Delete the old `style`, `role`, `tabIndex`, and `onKeyDown` props. Keep unavailable public scenarios as the existing plain `h2` so the page never advertises a detail action that returns 404.

- [ ] **Step 4: Add scoped responsive styles**

Add styles near the existing compare-page section in `app/globals.css`:

```css
.cmp-preview-banner {
  margin: 18px 0 22px;
  padding: 16px 18px;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border));
  border-left: 4px solid var(--accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 7%, var(--surface));
  color: var(--ink-2);
}
.cmp-preview-kicker {
  margin-bottom: 6px;
  color: var(--ink);
  font-size: 13px;
  font-weight: 750;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.cmp-preview-banner p { max-width: 88ch; margin: 0; line-height: 1.6; }
.cmp-preview-banner p + p { margin-top: 8px; }
.cmp-preview-banner a { color: var(--accent); font-weight: 650; }
.cmp-preview-banner a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

.cmp-scenario-trigger {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cmp-scenario-hint {
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.cmp-scenario-trigger:hover .cmp-scenario-hint { text-decoration-thickness: 2px; }
.cmp-scenario-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 3px; }
```

If `color-mix()` does not match the browser support target observed in the app, replace only those two color declarations with existing `var(--surface)`/`var(--border)` tokens.

- [ ] **Step 5: Verify the feature on the rendered page**

With the app running, verify signed out at `/`:

1. The banner appears before results with the exact approved copy.
2. The email link resolves to `mailto:sam@polariscollective.org`.
3. Clicking the title and the adjacent hint opens the correct modal.
4. Tab focuses the scenario button; Enter and Space open the modal through native button behavior.
5. A scenario whose detail endpoint is unavailable remains plain text without the hint.
6. At a narrow viewport, the banner and scenario heading wrap cleanly.

Verify signed in at `/`: the banner is absent and available scenario headings remain interactive.

- [ ] **Step 6: Run repository verification**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all Node tests pass, Next produces a successful production build, and `git diff --check` emits no output.

- [ ] **Step 7: Commit**

```bash
git add app/components/CompareGrid.js app/globals.css
git commit -m "Add public preview banner and scenario links"
```
