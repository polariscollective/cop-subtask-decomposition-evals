#!/usr/bin/env node
// Cheap, fast sanity check that a provider's API key actually works and
// that our callModel() integration for it is wired correctly — a plain
// text call, then a tool-call, for EVERY model listed under that provider
// in lib/models.js's MODEL_CATALOG (not just one representative), using
// the exact same lib/providers.js path the batch runners and the manual
// dashboard use. Not a cost estimate, not a real scenario: just "does this
// come back OK or does it error" — a model id can be real and still 404
// (e.g. deprecated for new accounts), which is exactly what this catches.
//
// Usage:
//   node scripts/smoke-test-providers.js [provider1 provider2 ...]
//   node scripts/smoke-test-providers.js            # tests every provider with a key set

import fs from "fs";
import { MODEL_CATALOG } from "../lib/models.js";
import { callModel } from "../lib/providers.js";

function loadEnvLocalOverriding(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// Which env var gates each provider — used only to decide what to skip,
// never printed.
const KEY_ENV_VAR = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  google: "GEMINI_API_KEY",
  meta: "META_API_KEY",
};

const TEST_TOOL = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

async function smokeTestModel(provider, model, providerLabel) {
  let textOk = false;
  let toolOk = false;
  let error = null;
  // 500, not a token-saving 20-50: some models (observed: Gemini 3.x)
  // reserve part of maxTokens for internal "thinking" tokens before any
  // visible output — too tight a budget burns entirely on that and comes
  // back with empty text, which looks like a failure but isn't one.
  try {
    const r = await callModel({
      provider,
      model,
      systemPrompt: "Reply with exactly one word.",
      messages: [{ role: "user", content: "Say hello." }],
      maxTokens: 500,
    });
    textOk = Boolean(r.text && !r.toolCall);
    if (!textOk) error = `unexpected text response: ${JSON.stringify(r)}`;
  } catch (e) {
    error = `text call failed: ${e.message}`;
  }

  if (!error) {
    try {
      const r = await callModel({
        provider,
        model,
        systemPrompt: "Use the tool when asked about weather.",
        tools: [TEST_TOOL],
        messages: [{ role: "user", content: "What's the weather in Paris?" }],
        maxTokens: 500,
      });
      toolOk = Boolean(r.toolCall?.name === "get_weather" && r.toolCall.arguments?.city);
      if (!toolOk) error = `unexpected tool-call response: ${JSON.stringify(r)}`;
    } catch (e) {
      error = `tool call failed: ${e.message}`;
    }
  }

  if (textOk && toolOk) {
    console.log(`✓ ${providerLabel} — ${model}`);
    return true;
  }
  console.log(`✗ ${providerLabel} — ${model} — ${error}`);
  return false;
}

async function main() {
  loadEnvLocalOverriding(".env.local");
  const requested = process.argv.slice(2);
  const providers = requested.length ? requested : Object.keys(MODEL_CATALOG);

  const results = [];
  for (const provider of providers) {
    const entry = MODEL_CATALOG[provider];
    if (!entry) {
      console.log(`✗ "${provider}" is not a provider in lib/models.js's MODEL_CATALOG`);
      results.push(false);
      continue;
    }
    const envVar = KEY_ENV_VAR[provider];
    const models = Object.keys(entry.models);
    if (envVar && !process.env[envVar]) {
      console.log(`○ ${entry.label} — skipped, ${envVar} not set (${models.length} models untested)`);
      continue;
    }
    for (const model of models) {
      results.push(await smokeTestModel(provider, model, entry.label));
    }
  }

  const failed = results.filter((r) => r === false).length;
  console.log(`\n${results.length - failed}/${results.length} models OK`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
