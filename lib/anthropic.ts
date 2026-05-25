import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { checkAndIncrementUsage } from "@/lib/usage";

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

// Serializable shape for the "which key are we using" decision. Carries NO
// plaintext key — that's resolved separately in `buildAnthropicClient` when
// we actually need to make a call. This keeps the user's key off Inngest's
// step-checkpoint storage.
export type AnthropicSelection =
  | { source: "user" }
  | { source: "default" }
  | { source: "rate_limited"; count: number; limit: number };

export type AnthropicForUserResult =
  | { client: Anthropic; source: "user" }
  | { client: Anthropic; source: "default" }
  | { client: Anthropic; source: "rate_limited"; count: number; limit: number };

/**
 * Decide which Anthropic key to use for a given user, and (when on the shared
 * key) atomically check+increment their daily quota.
 *
 * Crucially: does NOT return the user's plaintext key. The return shape is
 * a serializable enum safe to pass through Inngest step boundaries. Callers
 * that need a live client should pair this with `buildAnthropicClient` at
 * call site.
 *
 * - userId === null  → default key, no usage tracking (orphaned group).
 * - user has own key → source:"user" (key fetched lazily at call site).
 * - else             → check+increment counter. ok → default; over → rate_limited.
 */
export async function resolveAnthropicSelection(
  userId: string | null,
): Promise<AnthropicSelection> {
  if (userId === null) {
    return { source: "default" };
  }

  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { anthropicApiKeyEncrypted: true },
  });

  if (user?.anthropicApiKeyEncrypted) {
    return { source: "user" };
  }

  const usage = await checkAndIncrementUsage(userId);
  if (usage.ok) {
    return { source: "default" };
  }
  return { source: "rate_limited", count: usage.count, limit: usage.limit };
}

/**
 * Build the Anthropic client to use for a call, given a prior selection.
 *
 * - source:"user"  → re-fetch the encrypted key, decrypt, build a per-call
 *                    client. The plaintext key is never returned to the caller
 *                    and never crosses a serialization boundary.
 * - source:"default" → cached default client (uses ANTHROPIC_API_KEY env var).
 * - source:"rate_limited" → throws. Callers must branch on source first.
 *
 * Call this INSIDE the same Inngest step that makes the LLM request — the
 * client instance is not serializable and shouldn't outlive the step.
 */
export async function buildAnthropicClient(
  selection: AnthropicSelection,
  userId: string | null,
): Promise<Anthropic> {
  if (selection.source === "rate_limited") {
    throw new Error(
      "buildAnthropicClient called with rate_limited selection — caller should short-circuit before this",
    );
  }
  if (selection.source === "default") {
    return getAnthropic();
  }
  // source === "user" — re-fetch the encrypted key fresh.
  if (userId === null) {
    throw new Error("user-source selection requires a non-null userId");
  }
  const u = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { anthropicApiKeyEncrypted: true },
  });
  if (!u?.anthropicApiKeyEncrypted) {
    // User removed their key between selection and call — fall back to default.
    return getAnthropic();
  }
  const apiKey = decrypt(u.anthropicApiKeyEncrypted);
  return new Anthropic({ apiKey });
}

/**
 * Convenience wrapper for callers outside Inngest (server actions, etc.)
 * that don't need to cross a step boundary. Combines the two helpers above.
 *
 * Inside an Inngest function, prefer calling `resolveAnthropicSelection`
 * inside a `step.run` (so the rate-limit DB write gets step-level retry
 * semantics) and `buildAnthropicClient` inside the LLM step itself.
 */
export async function getAnthropicForUser(
  userId: string | null,
): Promise<AnthropicForUserResult> {
  const selection = await resolveAnthropicSelection(userId);
  if (selection.source === "rate_limited") {
    return {
      client: getAnthropic(), // not for use; included so callers don't have to handle a "no client" shape
      source: "rate_limited",
      count: selection.count,
      limit: selection.limit,
    };
  }
  const client = await buildAnthropicClient(selection, userId);
  return { client, source: selection.source };
}
