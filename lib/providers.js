import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// Server-side only. Keys live in .env.local and are never sent to the
// browser, since this file is only imported from app/api/*.
let anthropicClient = null;
export function getAnthropicClient() {
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

// xAI's API is Chat-Completions-compatible with OpenAI's — same SDK, just
// pointed at their base URL instead. Not the newer Responses API OpenAI
// itself uses below.
let xaiClient = null;
function getXaiClient() {
  if (!xaiClient) {
    if (!process.env.XAI_API_KEY) {
      throw new Error("XAI_API_KEY is not set in .env.local");
    }
    xaiClient = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: "https://api.x.ai/v1" });
  }
  return xaiClient;
}

let googleClient = null;
// Lazy/dynamic import: @google/genai isn't in package.json (the model
// catalog has no google provider committed yet, so this branch is
// currently unreachable) — a static import would break module load for
// every caller of this file the moment it's not installed.
async function getGoogleClient() {
  if (!googleClient) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set in .env.local");
    }
    const { GoogleGenAI } = await import("@google/genai");
    googleClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return googleClient;
}

// Meta's Llama API (developer.llama.com) is in preview and, like xAI,
// ships an OpenAI-Chat-Completions-compatible endpoint — same SDK/base-URL
// trick as getXaiClient. Base URL and model naming here are per Meta's
// published docs but untested against a real key as of this writing —
// smoke-test before trusting it for a real batch.
let metaClient = null;
function getMetaClient() {
  if (!metaClient) {
    if (!process.env.META_API_KEY) {
      throw new Error("META_API_KEY is not set in .env.local");
    }
    metaClient = new OpenAI({ apiKey: process.env.META_API_KEY, baseURL: "https://api.llama.com/compat/v1" });
  }
  return metaClient;
}

// Shared by xAI and Meta below — both are OpenAI Chat-Completions-compatible,
// differing only in which client (base URL/key) they use.
async function callChatCompletionsCompatible(client, { model, systemPrompt, tools, messages, maxTokens }) {
  const response = await client.chat.completions.create({
    model,
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    tools: tools
      ? tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }))
      : undefined,
    max_tokens: maxTokens,
  });
  const choice = response.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.[0];
  const finishReason = choice?.finish_reason;
  return {
    text: choice?.message?.content || "",
    toolCall: toolCall
      ? { name: toolCall.function.name, arguments: JSON.parse(toolCall.function.arguments || "{}") }
      : null,
    truncated: finishReason === "length",
    // "content_filter" is this API family's equivalent of Anthropic's
    // platform-level "refusal" stop_reason — normalized to the same string
    // so isPlatformBlocked works the same regardless of provider.
    stopReason: finishReason === "content_filter" ? "refusal" : finishReason ?? null,
    stopDetails: null,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
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
// Returns: { text, toolCall: {name, arguments} | null, truncated, stopReason,
// stopDetails, usage: {inputTokens, outputTokens} }
//
// stopReason/stopDetails matter beyond truncation: Anthropic's API can
// short-circuit a request server-side, before the model meaningfully
// responds, returning stop_reason "refusal" with empty content and a
// stop_details.category (e.g. "cyber"). That's a platform-level content
// block, not the model exercising judgment — evaluateAcceptance already
// treats it as "not accepted" (no text/tool call to find), but callers
// that care about *why* need this to tell the two apart.
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
      stopReason: response.status || null,
      stopDetails: null,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  if (provider === "xai") {
    return callChatCompletionsCompatible(getXaiClient(), { model, systemPrompt, tools, messages, maxTokens });
  }

  if (provider === "meta") {
    return callChatCompletionsCompatible(getMetaClient(), { model, systemPrompt, tools, messages, maxTokens });
  }

  if (provider === "google") {
    const client = await getGoogleClient();
    const response = await client.models.generateContent({
      model,
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: maxTokens,
        tools: tools
          ? [
              {
                functionDeclarations: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  // Our internal schema is already plain JSON Schema —
                  // parametersJsonSchema takes it as-is, no conversion to
                  // Google's own Schema/Type enum shape needed.
                  parametersJsonSchema: t.input_schema,
                })),
              },
            ]
          : undefined,
      },
    });
    const call = response.functionCalls?.[0];
    const finishReason = response.candidates?.[0]?.finishReason;
    const SAFETY_BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION"]);
    return {
      text: response.text || "",
      toolCall: call ? { name: call.name, arguments: call.args || {} } : null,
      truncated: finishReason === "MAX_TOKENS",
      // See xAI branch above — normalized to "refusal" for the same reason.
      stopReason: SAFETY_BLOCKED.has(finishReason) ? "refusal" : finishReason ?? null,
      stopDetails: null,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
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
    stopReason: response.stop_reason ?? null,
    stopDetails: response.stop_details ?? null,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
  };
}
