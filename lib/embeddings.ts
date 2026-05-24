const EMBEDDING_MODEL = "voyage-3-lite";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MAX_INPUT_CHARS = 8000;

export type EmbedInputType = "document" | "query";

/**
 * Embeds a single text string via Voyage AI. Returns null if VOYAGE_API_KEY
 * is missing or the API call fails — callers fall back to non-semantic
 * retrieval (recency-only ranking).
 *
 * Pass inputType="query" when embedding a search query for retrieval;
 * defaults to "document" for the index-side. Voyage uses this hint to
 * tune the embedding for better retrieval quality.
 */
export async function embed(
  text: string,
  inputType: EmbedInputType = "document",
): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: trimmed.slice(0, MAX_INPUT_CHARS),
        input_type: inputType,
        truncation: true,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "<unreadable>");
      console.warn("[embeddings] voyage HTTP", resp.status, errText.slice(0, 200));
      return null;
    }

    const data = (await resp.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    return data.data?.[0]?.embedding ?? null;
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
