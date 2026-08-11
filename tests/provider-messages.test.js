import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toAnthropicMessages,
  toChatCompletionsMessages,
  toResponsesInput,
  toGoogleContents,
  anthropicToolCalls,
  chatCompletionsToolCalls,
  responsesToolCalls,
  googleToolCalls,
} from "../lib/provider-messages.js";

// The one conversation shape the chained pipeline needs and the plain
// negotiation loop never produces: an assistant turn that both says
// something and calls a tool, followed by that tool's result being fed
// back in, followed by more plain text. Every provider encodes these three
// things differently; each translator below is checked against the same
// conversation so the differences stay visible side by side.
const CONVERSATION = [
  { role: "user", content: "Consolidate the consoles." },
  {
    role: "assistant",
    content: "Starting with an inventory.",
    toolCalls: [{ id: "call_1", name: "list_nodes", arguments: { scope: "all" } }],
  },
  { role: "tool", toolResults: [{ id: "call_1", name: "list_nodes", output: { nodes: ["a", "b"] } }] },
  { role: "user", content: "Now do the next step." },
];

test("toAnthropicMessages renders tool calls and results as content blocks", () => {
  assert.deepEqual(toAnthropicMessages(CONVERSATION), [
    { role: "user", content: "Consolidate the consoles." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Starting with an inventory." },
        { type: "tool_use", id: "call_1", name: "list_nodes", input: { scope: "all" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"nodes":["a","b"]}' }],
    },
    { role: "user", content: "Now do the next step." },
  ]);
});

test("toAnthropicMessages leaves a plain text-only conversation untouched", () => {
  const plain = [
    { role: "user", content: "Do it." },
    { role: "assistant", content: "No." },
  ];
  assert.deepEqual(toAnthropicMessages(plain), plain);
});

test("toAnthropicMessages omits the text block when a tool call carries no text", () => {
  const [assistant] = toAnthropicMessages([
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: {} }] },
  ]);
  assert.deepEqual(assistant.content, [{ type: "tool_use", id: "c1", name: "t", input: {} }]);
});

test("toChatCompletionsMessages puts each tool result in its own tool-role message", () => {
  assert.deepEqual(toChatCompletionsMessages(CONVERSATION), [
    { role: "user", content: "Consolidate the consoles." },
    {
      role: "assistant",
      content: "Starting with an inventory.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "list_nodes", arguments: '{"scope":"all"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"nodes":["a","b"]}' },
    { role: "user", content: "Now do the next step." },
  ]);
});

test("toChatCompletionsMessages expands parallel tool results into one message each", () => {
  const out = toChatCompletionsMessages([
    {
      role: "tool",
      toolResults: [
        { id: "c1", name: "a", output: { ok: 1 } },
        { id: "c2", name: "b", output: { ok: 2 } },
      ],
    },
  ]);
  assert.deepEqual(out, [
    { role: "tool", tool_call_id: "c1", content: '{"ok":1}' },
    { role: "tool", tool_call_id: "c2", content: '{"ok":2}' },
  ]);
});

test("toResponsesInput emits calls and outputs as their own top-level items", () => {
  assert.deepEqual(toResponsesInput(CONVERSATION), [
    { role: "user", content: "Consolidate the consoles." },
    { role: "assistant", content: "Starting with an inventory." },
    { type: "function_call", call_id: "call_1", name: "list_nodes", arguments: '{"scope":"all"}' },
    { type: "function_call_output", call_id: "call_1", output: '{"nodes":["a","b"]}' },
    { role: "user", content: "Now do the next step." },
  ]);
});

test("toResponsesInput drops the assistant text item when there is no text", () => {
  assert.deepEqual(toResponsesInput([{ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: {} }] }]), [
    { type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
  ]);
});

test("toGoogleContents renders calls and responses as parts", () => {
  assert.deepEqual(toGoogleContents(CONVERSATION), [
    { role: "user", parts: [{ text: "Consolidate the consoles." }] },
    {
      role: "model",
      parts: [
        { text: "Starting with an inventory." },
        { functionCall: { name: "list_nodes", args: { scope: "all" }, id: "call_1" } },
      ],
    },
    {
      role: "user",
      parts: [{ functionResponse: { id: "call_1", name: "list_nodes", response: { nodes: ["a", "b"] } } }],
    },
    { role: "user", parts: [{ text: "Now do the next step." }] },
  ]);
});

// Google requires functionResponse.response to be an object, so a tool that
// stubs out a bare scalar has to be wrapped rather than passed through.
test("toGoogleContents wraps a non-object tool output in an object", () => {
  const [content] = toGoogleContents([{ role: "tool", toolResults: [{ id: "c1", name: "t", output: "done" }] }]);
  assert.deepEqual(content.parts, [{ functionResponse: { id: "c1", name: "t", response: { result: "done" } } }]);
});

test("anthropicToolCalls reads every tool_use block in order", () => {
  const response = {
    content: [
      { type: "text", text: "ok" },
      { type: "tool_use", id: "toolu_1", name: "a", input: { x: 1 } },
      { type: "tool_use", id: "toolu_2", name: "b", input: {} },
    ],
  };
  assert.deepEqual(anthropicToolCalls(response), [
    { id: "toolu_1", name: "a", arguments: { x: 1 } },
    { id: "toolu_2", name: "b", arguments: {} },
  ]);
});

test("chatCompletionsToolCalls parses the stringified arguments", () => {
  const message = { tool_calls: [{ id: "call_1", function: { name: "a", arguments: '{"x":1}' } }] };
  assert.deepEqual(chatCompletionsToolCalls(message), [{ id: "call_1", name: "a", arguments: { x: 1 } }]);
});

test("chatCompletionsToolCalls treats missing arguments as an empty object", () => {
  const message = { tool_calls: [{ id: "call_1", function: { name: "a", arguments: "" } }] };
  assert.deepEqual(chatCompletionsToolCalls(message), [{ id: "call_1", name: "a", arguments: {} }]);
});

test("responsesToolCalls keys on call_id, not the item id", () => {
  const response = {
    output: [
      { type: "message", content: [] },
      { type: "function_call", id: "fc_abc", call_id: "call_1", name: "a", arguments: '{"x":1}' },
    ],
  };
  assert.deepEqual(responsesToolCalls(response), [{ id: "call_1", name: "a", arguments: { x: 1 } }]);
});

// Gemini 3.x rejects a replayed functionCall that comes back without the
// opaque thoughtSignature it issued with it ("Function call is missing a
// thought_signature in functionCall parts"), and that signature lives on
// the part, not inside functionCall — so it has to be read off the
// candidate parts and carried through, which response.functionCalls alone
// cannot do.
test("googleToolCalls carries the thought signature and the provider's own id", () => {
  const response = {
    candidates: [
      {
        content: {
          parts: [
            { text: "thinking" },
            { functionCall: { name: "a", args: { x: 1 }, id: "C5pWbQ6V" }, thoughtSignature: "sig-a" },
          ],
        },
      },
    ],
  };
  assert.deepEqual(googleToolCalls(response), [
    { id: "C5pWbQ6V", name: "a", arguments: { x: 1 }, signature: "sig-a" },
  ]);
});

test("googleToolCalls synthesises an id when the response carries none", () => {
  const response = { candidates: [{ content: { parts: [{ functionCall: { name: "a", args: {} } }] } }] };
  assert.deepEqual(googleToolCalls(response), [{ id: "call_0_a", name: "a", arguments: {}, signature: null }]);
});

test("toGoogleContents replays the thought signature alongside the call", () => {
  const [content] = toGoogleContents([
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "C5pWbQ6V", name: "a", arguments: { x: 1 }, signature: "sig-a" }],
    },
  ]);
  assert.deepEqual(content.parts, [
    { functionCall: { name: "a", args: { x: 1 }, id: "C5pWbQ6V" }, thoughtSignature: "sig-a" },
  ]);
});

test("toGoogleContents omits thoughtSignature when the call has none", () => {
  const [content] = toGoogleContents([
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "a", arguments: {}, signature: null }] },
  ]);
  assert.deepEqual(content.parts, [{ functionCall: { name: "a", args: {}, id: "c1" } }]);
});

test("toGoogleContents keys the function response to the call id", () => {
  const [content] = toGoogleContents([
    { role: "tool", toolResults: [{ id: "C5pWbQ6V", name: "a", output: { ok: true } }] },
  ]);
  assert.deepEqual(content.parts, [
    { functionResponse: { id: "C5pWbQ6V", name: "a", response: { ok: true } } },
  ]);
});

test("every extractor returns an empty array when the response has no tool call", () => {
  assert.deepEqual(anthropicToolCalls({ content: [{ type: "text", text: "no" }] }), []);
  assert.deepEqual(chatCompletionsToolCalls({ content: "no" }), []);
  assert.deepEqual(responsesToolCalls({ output: [] }), []);
  assert.deepEqual(googleToolCalls({}), []);
});
