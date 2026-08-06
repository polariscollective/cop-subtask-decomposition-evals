import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// Server-side only. Keys live in .env.local and are never sent to the
// browser, since this file is only imported from app/api/*.
let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

let openaiClient = null;
function getOpenAIClient() {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set in .env.local");
    }
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// Provider-agnostic single-turn call.
//
// `tools` (optional): our internal schema shape, produced by
// toolToAnthropicSchema — [{ name, description, input_schema: {type,
// properties, required} }]. input_schema is already plain JSON Schema, so
// it's reused as-is for OpenAI's `parameters` field, no translation needed.
//
// `messages`: universal shape [{ role: "user"|"assistant", content: string }]
// — plain strings only. This works because in this app's negotiation loop
// an assistant turn that produces a tool call is always terminal (the loop
// stops immediately), so a tool_use/function_call block is never round-
// tripped back into a later request — only plain refusal/rebuttal text is.
//
// Returns: { text, toolCall: {name, arguments} | null, truncated, usage: {inputTokens, outputTokens} }
export async function callModel({ provider, model, systemPrompt, tools, messages, maxTokens }) {
  if (provider === "openai") {
    const client = getOpenAIClient();
    const input = [
      ...(systemPrompt ? [{ role: "developer", content: systemPrompt }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const response = await client.responses.create({
      model,
      input,
      tools: tools
        ? tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          }))
        : undefined,
      max_output_tokens: maxTokens,
    });
    const functionCall = response.output?.find((o) => o.type === "function_call");
    return {
      text: response.output_text || "",
      toolCall: functionCall
        ? { name: functionCall.name, arguments: JSON.parse(functionCall.arguments || "{}") }
        : null,
      truncated: response.status === "incomplete",
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  // Default: Anthropic.
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  const toolUse = response.content.find((b) => b.type === "tool_use");
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return {
    text,
    toolCall: toolUse ? { name: toolUse.name, arguments: toolUse.input } : null,
    truncated: response.stop_reason === "max_tokens",
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
  };
}
