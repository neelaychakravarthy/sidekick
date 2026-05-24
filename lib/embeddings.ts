import OpenAI from "openai";

let cachedClient: OpenAI | null = null;
const EMBEDDING_MODEL = "text-embedding-3-small";

function getOpenAI(): OpenAI | null {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

/**
 * Embeds a single text string. Returns null if OPENAI_API_KEY is missing
 * or the API call fails — callers fall back to non-semantic retrieval.
 */
export async function embed(text: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const client = getOpenAI();
  if (!client) return null;

  try {
    const resp = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: trimmed.slice(0, 8000), // model limit ~8k tokens; clamp by chars as a cheap proxy
    });
    return resp.data[0]?.embedding ?? null;
  } catch (err) {
    console.warn("[embeddings] embed() failed; falling back to no-semantic", err);
    return null;
  }
}

export function serializeEmbedding(vec: number[]): string {
  return JSON.stringify(vec);
}

export function parseEmbedding(stored: string | null): number[] | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.every((n) => typeof n === "number")
      ? parsed
      : null;
  } catch {
    return null;
  }
}
