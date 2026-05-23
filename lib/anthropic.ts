import Anthropic from "@anthropic-ai/sdk";

let cachedClient: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (Anthropic console → API keys).",
    );
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

export const ANTHROPIC_MODEL = "claude-sonnet-4-6";
