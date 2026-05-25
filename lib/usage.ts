import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

export function getDailyLlmCallLimit(): number {
  const raw = process.env.DAILY_LLM_CALL_LIMIT ?? "50";
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 50;
  return parsed;
}

function nextUtcMidnight(from: Date): Date {
  return new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
}

export type UsageCheckResult =
  | { ok: true; count: number; limit: number }
  | { ok: false; count: number; limit: number };

/**
 * Atomically check and increment a user's daily LLM call count against
 * DAILY_LLM_CALL_LIMIT. Wraps the read/reset/increment in a single
 * transaction so concurrent invocations cannot race past the cap.
 *
 * - If the previous reset time has passed, counter resets to 0 first.
 * - If counter < limit, increment by 1 and return ok:true with new count.
 * - Else return ok:false with current count (counter is NOT incremented).
 *
 * Caller must handle the null userId case (orphaned group) before calling.
 */
export async function checkAndIncrementUsage(
  userId: string,
): Promise<UsageCheckResult> {
  const limit = getDailyLlmCallLimit();

  return await db.transaction(async (tx) => {
    const now = new Date();

    // Reset the counter if we've crossed the previous reset boundary.
    // Doing this as a conditional UPDATE keeps us in one round-trip.
    await tx
      .update(schema.users)
      .set({
        dailyLlmCallCount: 0,
        dailyLlmCallResetAt: nextUtcMidnight(now),
        updatedAt: now,
      })
      .where(
        sql`${schema.users.id} = ${userId} AND ${schema.users.dailyLlmCallResetAt} <= ${now}`,
      );

    const [u] = await tx
      .select({
        count: schema.users.dailyLlmCallCount,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!u) {
      // User row doesn't exist (deleted mid-flow). Treat as rate-limited so
      // we don't burn calls on an orphan.
      return { ok: false as const, count: 0, limit };
    }

    if (u.count >= limit) {
      return { ok: false as const, count: u.count, limit };
    }

    await tx
      .update(schema.users)
      .set({
        dailyLlmCallCount: sql`${schema.users.dailyLlmCallCount} + 1`,
        updatedAt: now,
      })
      .where(eq(schema.users.id, userId));

    return { ok: true as const, count: u.count + 1, limit };
  });
}
