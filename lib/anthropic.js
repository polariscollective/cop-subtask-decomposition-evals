import Anthropic from "@anthropic-ai/sdk";

// Server-side only. ANTHROPIC_API_KEY lives in .env.local and is never
// sent to the browser, since this file is only imported from app/api/*.
export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const MODEL = "claude-sonnet-4-6";
