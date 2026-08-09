# Model coverage status

The full set of callable models lives in `lib/models.js`'s `MODEL_CATALOG`
(Anthropic, OpenAI, xAI, Google). It only ever lists models that are actually
smoke-tested working — run `node scripts/smoke-test-providers.js` yourself to
re-verify (text + tool-calling, one real call each, cheap).

This file is the record of what's been tried and *isn't* in the catalog,
so the next person doesn't waste time rediscovering the same dead ends.
Update it whenever that changes.

## As of 2026-08-09

**Meta — not tested at all.** No `META_API_KEY` has ever been set, so the
two candidate models (Llama 4 Maverick, Llama 4 Scout via Meta's Llama API,
`api.llama.com/compat/v1`, OpenAI-compatible) have never been called even
once. `lib/providers.js` already has the `meta` provider branch wired up
(same pattern as xAI) — add `META_API_KEY` to `.env.local`, add a `meta:`
block back to `MODEL_CATALOG`, and smoke-test before trusting it.

**OpenAI — 4 "codex" ids confirmed broken.** `gpt-5.2-codex`,
`gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini` all show up in
this account's own `/v1/models` listing, but 404 ("Model not found") on a
real chat-completions call. Likely gated to the Codex CLI/product surface
rather than the general API — not something wrong in our integration.
Removed from the catalog.

**xAI — 1 id confirmed broken.** `grok-4.20-multi-agent-0309` is listed by
`/v1/models` but rejects a standard chat-completions call outright (400, no
response body). Probably needs a different request shape for its
multi-agent orchestration mode that the plain Chat-Completions-compatible
path (`lib/providers.js`'s `callChatCompletionsCompatible`) doesn't send.
Removed from the catalog.

**Everything currently in `MODEL_CATALOG`** (10 Anthropic, 29 OpenAI, 5 xAI,
12 Google — 56 total) passed the smoke test as of this date: real key, real
call, text response and tool-calling both confirmed.
