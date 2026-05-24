import { desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { embed, parseEmbedding } from "@/lib/embeddings";

export type RetrievedMemory = {
  key: string;
  value: unknown;
  source: "inferred";
};

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Retrieve the top-K most-relevant memories for a given query text.
 * - If queryText is empty or embedding fails: returns the K most-recently-updated rows.
 * - Otherwise: ranks embedded rows by cosine similarity, fills remaining slots
 *   (up to K) with the most-recent rows that have no embedding.
 */
export async function retrieveTopMemories(
  groupId: string,
  queryText: string,
  k: number,
): Promise<RetrievedMemory[]> {
  // Pull all memory rows for the group (small in MVP; revisit at scale)
  const rows = await db
    .select({
      key: schema.groupMemory.key,
      value: schema.groupMemory.value,
      source: schema.groupMemory.source,
      embedding: schema.groupMemory.embedding,
      updatedAt: schema.groupMemory.updatedAt,
    })
    .from(schema.groupMemory)
    .where(eq(schema.groupMemory.groupId, groupId))
    .orderBy(desc(schema.groupMemory.updatedAt))
    .limit(200); // hard cap to bound JS work

  if (rows.length === 0) return [];

  const queryVec = await embed(queryText);

  if (!queryVec) {
    // No semantic ranking possible — recency only.
    return rows
      .slice(0, k)
      .map(({ key, value, source }) => ({ key, value, source }));
  }

  // Split: embedded rows get cosine ranking; non-embedded get recency fallback.
  type Scored = { row: (typeof rows)[number]; score: number };
  const embedded: Scored[] = [];
  const nonEmbedded: typeof rows = [];

  for (const row of rows) {
    const vec = parseEmbedding(row.embedding);
    if (vec && vec.length > 0) {
      embedded.push({ row, score: cosineSimilarity(queryVec, vec) });
    } else {
      nonEmbedded.push(row);
    }
  }

  embedded.sort((a, b) => b.score - a.score);

  const selected: typeof rows = [];
  for (const { row } of embedded) {
    if (selected.length >= k) break;
    selected.push(row);
  }
  for (const row of nonEmbedded) {
    if (selected.length >= k) break;
    selected.push(row);
  }

  return selected.map(({ key, value, source }) => ({ key, value, source }));
}
