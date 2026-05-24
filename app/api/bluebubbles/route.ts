import crypto from "node:crypto";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { db, schema } from "@/lib/db";
import { inngest } from "@/lib/inngest/client";

const BB_WEBHOOK_SECRET = process.env.BLUEBUBBLES_WEBHOOK_SECRET;

function verifySecret(provided: string | null): boolean {
  if (!BB_WEBHOOK_SECRET || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(BB_WEBHOOK_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!verifySecret(secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: {
    type?: string;
    data?: {
      guid?: string;
      text?: string;
      handle?: { address?: string };
      chats?: Array<{ guid?: string; displayName?: string }>;
      dateCreated?: number;
      isFromMe?: boolean;
    };
  };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Only handle inbound new-message events; ignore others (typing indicators, etc.).
  if (payload.type !== "new-message") {
    return NextResponse.json({ ok: true, ignored: payload.type });
  }

  const d = payload.data;
  if (!d?.text || !d.guid || !d.chats?.[0]?.guid) {
    return NextResponse.json({ ok: true, ignored: "incomplete" });
  }

  // Skip messages sent BY us (echo of our own sends).
  if (d.isFromMe) {
    return NextResponse.json({ ok: true, ignored: "from_me" });
  }

  const chatGuid = d.chats[0].guid;
  const chatName = d.chats[0].displayName ?? "iMessage chat";
  const senderHandle = d.handle?.address ?? null;
  const msgGuid = d.guid;
  const text = d.text;
  const ts = d.dateCreated ? new Date(d.dateCreated) : new Date();

  // Self-heal: find or create the group row.
  let group = await db.query.groups.findFirst({
    where: eq(schema.groups.bluebubblesChatGuid, chatGuid),
  });
  if (!group) {
    const inserted = await db
      .insert(schema.groups)
      .values({
        platform: "imessage",
        bluebubblesChatGuid: chatGuid,
        name: chatName,
      })
      .returning();
    group = inserted[0];
  }

  // Upsert sender as group member (by bluebubblesHandle).
  if (senderHandle) {
    const existing = await db.query.groupMembers.findFirst({
      where: and(
        eq(schema.groupMembers.groupId, group.id),
        eq(schema.groupMembers.bluebubblesHandle, senderHandle),
      ),
    });
    if (!existing) {
      await db.insert(schema.groupMembers).values({
        groupId: group.id,
        bluebubblesHandle: senderHandle,
        displayName: senderHandle, // fallback display
      });
    }
  }

  // Persist message (best-effort dedup on bluebubblesMessageGuid via find first).
  const existingMsg = await db.query.messages.findFirst({
    where: and(
      eq(schema.messages.groupId, group.id),
      eq(schema.messages.bluebubblesMessageGuid, msgGuid),
    ),
  });
  let messageId: string;
  if (existingMsg) {
    messageId = existingMsg.id;
  } else {
    const inserted = await db
      .insert(schema.messages)
      .values({
        groupId: group.id,
        platform: "imessage",
        bluebubblesMessageGuid: msgGuid,
        text,
        ts,
        raw: { source: "bluebubbles", payload: d } as Record<string, unknown>,
      })
      .returning({ id: schema.messages.id });
    messageId = inserted[0].id;
  }

  // Emit Inngest event for the analyzer.
  await inngest.send({
    name: "message.received",
    data: {
      groupId: group.id,
      messageId,
      bluebubblesMessageGuid: msgGuid,
      text,
    },
  });

  return NextResponse.json({ ok: true });
}
