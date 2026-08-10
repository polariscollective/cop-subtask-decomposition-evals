# Public preview banner and scenario links — design

Date: 2026-08-10

## Goal

Make the public root page unambiguously read as an early product preview,
not as a publication of statistically meaningful evaluation results. Make it
equally obvious that scenario names open the existing scenario-detail view.

## Scope

The change applies only to the canonical public route `/`. No routing or
redirect behavior changes. The preview banner is rendered only when the
visitor is signed out; authenticated users do not see it.

## Preview banner

Add a compact informational banner near the top of `CompareGrid`, below the
page introduction and before loading, error, filters, or results content. It
uses the existing visual system and a dedicated semantic class rather than
introducing a new dependency or global design system.

Copy:

> **Work in progress**
>
> This is an early preview intended to show the direction this project could
> take. It currently includes only a few models, a limited selection of
> argumentation styles, and two example scenarios that have not yet been fully
> validated. No statistically significant results or conclusions are
> presented here yet, and several aspects of the results display still need
> improvement.
>
> For feedback—or to request internal access to experiment with scenario
> generation and evaluation runs—feel free to contact
> [sam@polariscollective.org](mailto:sam@polariscollective.org).

The email address is a normal `mailto:` link with a visible keyboard focus
state inherited from or consistent with the existing link treatment.

## Scenario detail affordance

Each scenario heading becomes one accessible button that opens the existing
`ScenarioDetailModal`. The button contains both the scenario title and the
adjacent text `Click here for more details`, so clicking either part has the
same result. It retains heading semantics around the button, supports keyboard
activation natively, and receives a visible hover/focus treatment.

The existing detail modal, data fetch, close behavior, and scenario list stay
unchanged.

## Responsive and accessibility behavior

On narrow screens, the title and details hint may wrap without overlapping the
comparison panels. The banner remains readable with the existing page padding.
The new interactive heading uses a real `button`, not a clickable `div`, and
does not duplicate nested click targets.

## Verification

- Signed out at `/`: the banner is visible with the exact approved copy and a
  working email link.
- Signed in at `/`: the banner is absent.
- Clicking either a scenario title or `Click here for more details` opens the
  correct scenario-detail modal.
- Keyboard focus and Enter/Space activation work on each scenario heading.
- The page remains usable at desktop and narrow mobile widths.
- Existing lint/test/build checks relevant to the changed files pass.

## Non-goals

- Changing `/compare`, redirects, middleware, APIs, result calculations, or
  which records are public.
- Claiming that the displayed data supports statistical conclusions.
- Creating dedicated scenario-detail routes or changing the existing modal.
