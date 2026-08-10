# Research direction link — design

Date: 2026-08-10

## Goal

Optionally link the signed-out public preview banner to a document that
explains the research direction in more detail.

## Configuration

Use the server-side environment variable `RESEARCH_DIRECTION_URL`. No existing
environment variable in the project represents this document.

`app/page.js` reads the variable and passes its value to `CompareGrid` as a
`researchDirectionUrl` prop. This avoids adding an unnecessary
`NEXT_PUBLIC_*` variable while still allowing the public page to render the
configured link.

Add `RESEARCH_DIRECTION_URL` with an empty example value to `.env.example` so
the deployment option is discoverable without committing a real document URL.

## Banner behavior

The extra line remains part of the existing signed-out-only preview banner.
When `RESEARCH_DIRECTION_URL` is a non-empty string, render:

> **More info:** [Information about the research direction](configured URL)

The link uses normal anchor navigation and opens in the current tab. When the
variable is absent or empty, render no label, empty link, or extra spacing.
Authenticated users continue not to see the preview banner or this link.

## Scope and verification

No routing, middleware, API, authentication, public-data filtering, or result
calculation changes.

Verification is limited to a production build and rendered-page checks, in
line with the user's request to avoid UI test work:

- With `RESEARCH_DIRECTION_URL` set, the signed-out banner displays the exact
  label and points to the configured URL.
- With it unset, the banner is unchanged and contains no empty More info row.
- Signed-in visitors do not see the banner in either case.
