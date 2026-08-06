// Hardcoded pricing catalog — USD per 1M tokens. Update here as pricing
// changes; there's no live pricing API for either provider.
export const MODEL_CATALOG = {
  anthropic: {
    label: "Anthropic",
    models: {
      "claude-opus-5": { label: "Claude Opus 5", input: 5.0, output: 25.0 },
      "claude-sonnet-5": { label: "Claude Sonnet 5", input: 3.0, output: 15.0 },
      "claude-sonnet-4-6": { label: "Claude Sonnet 4.6", input: 3.0, output: 15.0 },
      "claude-opus-4-8": { label: "Claude Opus 4.8", input: 5.0, output: 25.0 },
      "claude-opus-4-7": { label: "Claude Opus 4.7", input: 5.0, output: 25.0 },
      "claude-fable-5": { label: "Claude Fable 5", input: 10.0, output: 50.0 },
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
      "gpt-5.4": { label: "GPT-5.4", input: 2.5, output: 15.0 },
      "gpt-5": { label: "GPT-5", input: 1.25, output: 10.0 },
      "gpt-4.1": { label: "GPT-4.1", input: 2.0, output: 8.0 },
      "gpt-4.1-mini": { label: "GPT-4.1 Mini", input: 0.4, output: 1.6 },
      o3: { label: "o3", input: 2.0, output: 8.0 },
      "o3-mini": { label: "o3-mini", input: 1.1, output: 4.4 },
      "gpt-4o": { label: "GPT-4o", input: 2.5, output: 10.0 },
      "gpt-4o-mini": { label: "GPT-4o Mini", input: 0.15, output: 0.6 },
    },
  },
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
