import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

const SECRET = process.env.BLUEBUBBLES_WEBHOOK_SECRET;
const MAX_ATTEMPTS = 3;

function verifySecret(provided: string | null): boolean {
  if (!SECRET || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req.nextUrl.searchParams.get("secret"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    id?: string;
    success?: boolean;
    externalMessageId?: string | null;
    error?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  if (body.success) {
    await db
      .update(schema.outboundMessages)
      .set({
        status: "sent",
        externalMessageId: body.externalMessageId ?? null,
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.outboundMessages.id, body.id));
    return NextResponse.json({ ok: true });
  }

  // Failure: retry until MAX_ATTEMPTS, then mark failed.
  const [row] = await db
    .select({ attempts: schema.outboundMessages.attempts })
    .from(schema.outboundMessages)
    .where(eq(schema.outboundMessages.id, body.id))
    .limit(1);
  const nextStatus =
    (row?.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS ? "failed" : "pending";
  await db
    .update(schema.outboundMessages)
    .set({
      status: nextStatus,
      errorText: body.error ?? null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.outboundMessages.id, body.id));
  return NextResponse.json({ ok: true, status: nextStatus });
}
