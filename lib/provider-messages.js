// Translation of this app's universal conversation shape into each
// provider's own wire format. Data only — imports nothing, so it stays
// testable without a key, a network call, or dragging lib/providers.js
// (which holds the API clients) into anything.
//
// The universal shape callModel accepts:
//
//   { role: "user",      content: string }
//   { role: "assistant", content: string, toolCalls?: [{ id, name, arguments }] }
//   { role: "tool",      toolResults: [{ id, name, output }] }
//
// A message that is plain text passes through unchanged, which is why the
// plan/execute negotiation loop — which only ever produces text — needed no
// changes when this was added. Only the chained pipeline, where the model
// must see its own earlier tool calls and their results before choosing the
// next one, produces the other two forms.

function isToolResultMessage(m) {
  return m.role === "tool";
}

function hasToolCalls(m) {
  return Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
}

// Anthropic: tool calls and their results are content *blocks*, and every
// tool_use in one assistant message must be answered by a tool_result with
// the matching id in the single next user message — the API rejects the
// request outright otherwise.
export function toAnthropicMessages(messages) {
  return messages.map((m) => {
    if (isToolResultMessage(m)) {
      return {
        role: "user",
        content: m.toolResults.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: JSON.stringify(r.output),
        })),
      };
    }
    if (hasToolCalls(m)) {
      return {
        role: m.role,
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

// OpenAI Chat Completions (and its clones, xAI/Meta): tool calls ride on
// the assistant message as `tool_calls` with stringified arguments, and
// each result is its own `role: "tool"` message keyed by tool_call_id — so
// one universal tool message with N results fans out into N messages here,
// unlike Anthropic's single grouped one.
export function toChatCompletionsMessages(messages) {
  return messages.flatMap((m) => {
    if (isToolResultMessage(m)) {
      return m.toolResults.map((r) => ({
        role: "tool",
        tool_call_id: r.id,
        content: JSON.stringify(r.output),
      }));
    }
    if (hasToolCalls(m)) {
      return [
        {
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        },
      ];
    }
    return [{ role: m.role, content: m.content }];
  });
}

// OpenAI's Responses API: not a message list but an *item* list, where a
// call and its output are siblings of the text turns rather than fields on
// them. An assistant turn that both spoke and called a tool therefore
// becomes two items.
export function toResponsesInput(messages) {
  return messages.flatMap((m) => {
    if (isToolResultMessage(m)) {
      return m.toolResults.map((r) => ({
        type: "function_call_output",
        call_id: r.id,
        output: JSON.stringify(r.output),
      }));
    }
    if (hasToolCalls(m)) {
      return [
        ...(m.content ? [{ role: m.role, content: m.content }] : []),
        ...m.toolCalls.map((c) => ({
          type: "function_call",
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.arguments),
        })),
      ];
    }
    return [{ role: m.role, content: m.content }];
  });
}

// Google: everything is a `part` inside a content entry, and there are only
// two roles — "user" and "model" — so tool results go back in as user
// parts. Unlike the other three there is no call id to correlate on; the
// function name is the only link, which is why the ids the rest of this
// module carries are simply absent here.
export function toGoogleContents(messages) {
  return messages.map((m) => {
    if (isToolResultMessage(m)) {
      return {
        role: "user",
        parts: m.toolResults.map((r) => ({
          functionResponse: {
            id: r.id,
            name: r.name,
            // The API requires an object here; a tool whose stub is a bare
            // scalar would be rejected as-is.
            response: r.output !== null && typeof r.output === "object" ? r.output : { result: r.output },
          },
        })),
      };
    }
    const role = m.role === "assistant" ? "model" : "user";
    if (hasToolCalls(m)) {
      return {
        role,
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...m.toolCalls.map((c) => ({
            functionCall: { name: c.name, args: c.arguments, id: c.id },
            // Gemini 3.x refuses a replayed call whose thoughtSignature is
            // missing, so it has to go back exactly as it came — but the
            // key must be absent, not null, for models that never issue one.
            ...(c.signature ? { thoughtSignature: c.signature } : {}),
          })),
        ],
      };
    }
    return { role, parts: [{ text: m.content }] };
  });
}

// The other direction: pulling *every* tool call out of a provider's raw
// response, normalised to { id, name, arguments }. Every one of these can
// return more than one call — Anthropic and Google in particular emit
// several in a single response — and the chained loop must answer all of
// them, so none of these may collapse to just the first.

export function anthropicToolCalls(response) {
  return (response.content || [])
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, arguments: b.input }));
}

export function chatCompletionsToolCalls(message) {
  return (message?.tool_calls || []).map((c) => ({
    id: c.id,
    name: c.function.name,
    arguments: JSON.parse(c.function.arguments || "{}"),
  }));
}

export function responsesToolCalls(response) {
  return (response.output || [])
    .filter((o) => o.type === "function_call")
    // call_id, not id: the Responses API gives a function_call item both an
    // item id (fc_…) and a call_id, and function_call_output must reference
    // the latter.
    .map((o) => ({ id: o.call_id, name: o.name, arguments: JSON.parse(o.arguments || "{}") }));
}

// Read off the candidate parts rather than the response.functionCalls
// convenience accessor: the thoughtSignature Gemini 3.x demands back sits
// on the *part*, beside functionCall, and never appears in that accessor.
export function googleToolCalls(response) {
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({
      id: p.functionCall.id ?? `call_${i}_${p.functionCall.name}`,
      name: p.functionCall.name,
      arguments: p.functionCall.args || {},
      signature: p.thoughtSignature ?? null,
    }));
}
