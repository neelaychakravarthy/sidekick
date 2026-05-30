import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

const SECRET = process.env.BLUEBUBBLES_WEBHOOK_SECRET;
const BATCH = 10;
const STALE_MS = 2 * 60 * 1000;

function verifySecret(provided: string | null): boolean {
  if (!SECRET || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!verifySecret(req.nextUrl.searchParams.get("secret"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Reclaim rows that were claimed for sending but never acked (bridge crashed
  // mid-send). They return to pending and get re-dispatched. The bridge uses a
  // stable tempGuid (derived from row id) so a real double-send dedups on the
  // BlueBubbles side.
  await db
    .update(schema.outboundMessages)
    .set({ status: "pending", updatedAt: new Date() })
    .where(
      and(
        eq(schema.outboundMessages.status, "sending"),
        lt(schema.outboundMessages.claimedAt, new Date(Date.now() - STALE_MS)),
      ),
    );

  // Atomically claim a batch (single bridge → no SKIP LOCKED needed; if you
  // ever run multiple bridges, add FOR UPDATE SKIP LOCKED).
  const claimed = await db.transaction(async (tx) => {
    const pending = await tx
      .select({ id: schema.outboundMessages.id })
      .from(schema.outboundMessages)
      .where(eq(schema.outboundMessages.status, "pending"))
      .orderBy(asc(schema.outboundMessages.createdAt))
      .limit(BATCH);
    if (pending.length === 0) return [];
    const ids = pending.map((p) => p.id);
    return tx
      .update(schema.outboundMessages)
      .set({
        status: "sending",
        claimedAt: new Date(),
        attempts: sql`${schema.outboundMessages.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(inArray(schema.outboundMessages.id, ids))
      .returning({
        id: schema.outboundMessages.id,
        bluebubblesChatGuid: schema.outboundMessages.bluebubblesChatGuid,
        text: schema.outboundMessages.text,
      });
  });

  return NextResponse.json({ messages: claimed });
}
