import { test } from "node:test";
import assert from "node:assert/strict";
import { callChatCompletionsCompatible } from "../lib/providers.js";

// The Chat-Completions branch is the one seam in lib/providers.js that
// takes its client as an argument, so it can be exercised against a fake
// one without a key or a network call. The other three branches build
// their client internally and are covered by
// tests/provider-messages.test.js (the translation they delegate to) plus
// a real one-chain run before any batch.
function fakeClient(response, capture) {
  return {
    chat: {
      completions: {
        create: async (request) => {
          capture.request = request;
          return response;
        },
      },
    },
  };
}

const TOOL_RESPONSE = {
  choices: [
    {
      message: {
        content: "Calling it.",
        tool_calls: [
          { id: "call_1", function: { name: "list_nodes", arguments: '{"scope":"all"}' } },
          { id: "call_2", function: { name: "audit", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

test("callChatCompletionsCompatible returns every tool call, not just the first", async () => {
  const capture = {};
  const result = await callChatCompletionsCompatible(fakeClient(TOOL_RESPONSE, capture), {
    model: "m",
    messages: [{ role: "user", content: "go" }],
    maxTokens: 100,
  });
  assert.deepEqual(result.toolCalls, [
    { id: "call_1", name: "list_nodes", arguments: { scope: "all" } },
    { id: "call_2", name: "audit", arguments: {} },
  ]);
});

test("callChatCompletionsCompatible still exposes the first call as toolCall", async () => {
  const capture = {};
  const result = await callChatCompletionsCompatible(fakeClient(TOOL_RESPONSE, capture), {
    model: "m",
    messages: [{ role: "user", content: "go" }],
    maxTokens: 100,
  });
  assert.deepEqual(result.toolCall, { id: "call_1", name: "list_nodes", arguments: { scope: "all" } });
});

test("callChatCompletionsCompatible sends a tool result back in the provider's own shape", async () => {
  const capture = {};
  await callChatCompletionsCompatible(fakeClient(TOOL_RESPONSE, capture), {
    model: "m",
    systemPrompt: "sys",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "call_1", name: "t", arguments: {} }] },
      { role: "tool", toolResults: [{ id: "call_1", name: "t", output: { ok: true } }] },
    ],
    maxTokens: 100,
  });
  assert.deepEqual(capture.request.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "ok",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
  ]);
});
