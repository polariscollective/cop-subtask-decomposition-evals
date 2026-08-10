// Hardcoded pricing catalog — USD per 1M tokens. Update here as pricing
// changes; there's no live pricing API for any of these four providers.
//
// Every id below was pulled from that provider's own live /models listing
// against this project's key (see
// `node scripts/smoke-test-providers.js`), then filtered down to
// text-chat/tool-calling-capable models — dropped: embeddings, TTS,
// transcription, realtime/voice, image and video generation, moderation,
// and (OpenAI) the oldest completion-only models (babbage/davinci/turbo-
// instruct) and gpt-3.5, which add no eval value here. Being *listed*
// doesn't mean callable — several ids that show up in a provider's own
// listing 404 in practice (e.g. Google's 2.x-era ids, "no longer available
// to new users") — the smoke test is what actually decides what's usable.
export const MODEL_CATALOG = {
  anthropic: {
    label: "Anthropic",
    // All 10 ids below are pulled straight from this account's own live
    // /v1/models listing and smoke-tested OK (text + tool-calling), 10/10.
    models: {
      "claude-opus-5": { label: "Claude Opus 5", input: 5.0, output: 25.0 },
      "claude-sonnet-5": { label: "Claude Sonnet 5", input: 3.0, output: 15.0 },
      "claude-fable-5": { label: "Claude Fable 5", input: 10.0, output: 50.0 },
      "claude-opus-4-8": { label: "Claude Opus 4.8", input: 5.0, output: 25.0 },
      "claude-opus-4-7": { label: "Claude Opus 4.7", input: 5.0, output: 25.0 },
      "claude-opus-4-6": { label: "Claude Opus 4.6", input: 5.0, output: 25.0 },
      "claude-sonnet-4-6": { label: "Claude Sonnet 4.6", input: 3.0, output: 15.0 },
      "claude-opus-4-5-20251101": { label: "Claude Opus 4.5", input: 5.0, output: 25.0 },
      "claude-sonnet-4-5-20250929": { label: "Claude Sonnet 4.5", input: 3.0, output: 15.0 },
      // Unpinned alias, deliberately: every saved run and all three batch
      // scripts' DEFAULT_MODELS use this id. Swapping it for the dated
      // snapshot id without an alias made providerForModel throw on the
      // batch runner's own defaults and hid 42 saved runs from /compare,
      // which builds its model list from this catalog alone.
      "claude-haiku-4-5": { label: "Claude Haiku 4.5", input: 1.0, output: 5.0 },
    },
  },
  openai: {
    label: "OpenAI",
    models: {
      "gpt-5.6-sol": { label: "GPT-5.6 Sol", input: 5.0, output: 30.0 },
      "gpt-5.6-terra": { label: "GPT-5.6 Terra", input: 2.0, output: 12.0 },
      "gpt-5.6-luna": { label: "GPT-5.6 Luna", input: 0.2, output: 1.2 },
      "gpt-5.5": { label: "GPT-5.5", input: 5.0, output: 30.0 },
      "gpt-5.5-pro": { label: "GPT-5.5 Pro", input: 10.0, output: 60.0 },
      "gpt-5.4": { label: "GPT-5.4", input: 2.5, output: 15.0 },
      "gpt-5.4-mini": { label: "GPT-5.4 Mini", input: 0.3, output: 1.5 },
      "gpt-5.4-nano": { label: "GPT-5.4 Nano", input: 0.06, output: 0.3 },
      "gpt-5.4-pro": { label: "GPT-5.4 Pro", input: 8.0, output: 50.0 },
      "gpt-5.3-chat-latest": { label: "GPT-5.3 Chat", input: 2.0, output: 12.0 },
      "gpt-5.3-codex": { label: "GPT-5.3 Codex", input: 2.0, output: 12.0 },
      "gpt-5.2": { label: "GPT-5.2", input: 1.75, output: 11.0 },
      "gpt-5.2-pro": { label: "GPT-5.2 Pro", input: 7.0, output: 45.0 },
      // gpt-5.2-codex and every gpt-5.1-codex* variant are listed by
      // /v1/models but 404 on chat completions — smoke-tested, confirmed
      // dead via this integration (likely gated to the Codex CLI/product
      // surface, not the general API). Omitted.
      "gpt-5.1": { label: "GPT-5.1", input: 1.5, output: 10.0 },
      "gpt-5": { label: "GPT-5", input: 1.25, output: 10.0 },
      "gpt-5-pro": { label: "GPT-5 Pro", input: 6.0, output: 40.0 },
      "gpt-5-mini": { label: "GPT-5 Mini", input: 0.25, output: 1.2 },
      "gpt-5-nano": { label: "GPT-5 Nano", input: 0.05, output: 0.25 },
      o3: { label: "o3", input: 2.0, output: 8.0 },
      "o3-mini": { label: "o3-mini", input: 1.1, output: 4.4 },
      "o4-mini": { label: "o4-mini", input: 1.1, output: 4.4 },
      o1: { label: "o1", input: 15.0, output: 60.0 },
      "o1-pro": { label: "o1-pro", input: 30.0, output: 120.0 },
      "gpt-4.1": { label: "GPT-4.1", input: 2.0, output: 8.0 },
      "gpt-4.1-mini": { label: "GPT-4.1 Mini", input: 0.4, output: 1.6 },
      "gpt-4.1-nano": { label: "GPT-4.1 Nano", input: 0.1, output: 0.4 },
      "gpt-4o": { label: "GPT-4o", input: 2.5, output: 10.0 },
      "gpt-4o-mini": { label: "GPT-4o Mini", input: 0.15, output: 0.6 },
      "gpt-4-turbo": { label: "GPT-4 Turbo", input: 10.0, output: 30.0 },
    },
  },
  xai: {
    label: "xAI",
    models: {
      "grok-4.5": { label: "Grok 4.5", input: 4.0, output: 20.0 },
      "grok-4.3": { label: "Grok 4.3", input: 3.5, output: 17.0 },
      "grok-4.20-0309-reasoning": { label: "Grok 4.20 Reasoning", input: 4.0, output: 22.0 },
      "grok-4.20-0309-non-reasoning": { label: "Grok 4.20 Non-Reasoning", input: 2.0, output: 8.0 },
      // grok-4.20-multi-agent-0309 omitted — see docs/MODEL_STATUS.md.
      "grok-build-0.1": { label: "Grok Build 0.1", input: 2.0, output: 8.0 },
    },
  },
  google: {
    label: "Google",
    models: {
      // 2.x-era pinned ids (gemini-2.5-pro/flash/flash-lite, gemini-2.0-*)
      // all 404 on this account — "no longer available to new users" —
      // omitted entirely rather than listed-but-dead. *-latest rolling
      // aliases and the 3.x family are what's actually callable.
      "gemini-pro-latest": { label: "Gemini Pro (latest)", input: 1.25, output: 10.0 },
      "gemini-flash-latest": { label: "Gemini Flash (latest)", input: 0.3, output: 2.5 },
      "gemini-flash-lite-latest": { label: "Gemini Flash-Lite (latest)", input: 0.1, output: 0.4 },
      "gemini-3.6-flash": { label: "Gemini 3.6 Flash", input: 0.35, output: 3.0 },
      "gemini-3.5-flash": { label: "Gemini 3.5 Flash", input: 0.3, output: 2.5 },
      "gemini-3.5-flash-lite": { label: "Gemini 3.5 Flash-Lite", input: 0.1, output: 0.4 },
      "gemini-3.1-pro-preview": { label: "Gemini 3.1 Pro Preview", input: 2.0, output: 12.0 },
      "gemini-3.1-flash-lite": { label: "Gemini 3.1 Flash-Lite", input: 0.1, output: 0.4 },
      "gemini-3.1-flash-lite-preview": { label: "Gemini 3.1 Flash-Lite Preview", input: 0.1, output: 0.4 },
      "gemini-3-flash-preview": { label: "Gemini 3 Flash Preview", input: 0.3, output: 2.5 },
      "gemma-4-31b-it": { label: "Gemma 4 31B IT", input: 0.1, output: 0.3 },
      "gemma-4-26b-a4b-it": { label: "Gemma 4 26B A4B IT", input: 0.08, output: 0.25 },
    },
  },
  // Meta pulled for now — no META_API_KEY, never smoke-tested, so nothing
  // to back the two candidate ids up. lib/providers.js's getMetaClient/
  // "meta" branch is still there; re-add a `meta:` block here (see git
  // history) once there's a key to actually verify against.
};

export function costForCall({ provider, model, inputTokens = 0, outputTokens = 0 }) {
  const m = MODEL_CATALOG[provider]?.models?.[model];
  if (!m) return 0;
  return (inputTokens / 1_000_000) * m.input + (outputTokens / 1_000_000) * m.output;
}

export function defaultModelFor(provider) {
  const models = MODEL_CATALOG[provider]?.models;
  return models ? Object.keys(models)[0] : null;
}

// Batch scripts only ever have a model id on hand (e.g. from --models on
// the CLI), not the provider it belongs to — this is the single source of
// truth both the manual dashboard's own provider dropdown and the batch
// runners can derive it from, instead of each hardcoding "anthropic".
export function providerForModel(model) {
  for (const [key, p] of Object.entries(MODEL_CATALOG)) {
    if (model in p.models) return key;
  }
  throw new Error(`Unknown model "${model}" — not in any MODEL_CATALOG provider`);
}
