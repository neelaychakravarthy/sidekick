import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { inngest } from "@/lib/inngest/client";
import { sendBluebubblesMessage } from "@/lib/bluebubbles/client";
import { buildClaimPromptMessage } from "@/lib/messages";

export const maxDuration = 60;

const BB_WEBHOOK_SECRET = process.env.BLUEBUBBLES_WEBHOOK_SECRET;
const CLAIM_RE = /(?:@\w+\s+)?\/?claim\s+([a-zA-Z0-9]+)/i;

function verifySecret(provided: string | null): boolean {
  if (!BB_WEBHOOK_SECRET || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(BB_WEBHOOK_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req.nextUrl.searchParams.get("secret"))) {
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

  if (payload.type !== "new-message") {
    return NextResponse.json({ ok: true, ignored: payload.type ?? "no_type" });
  }
  const d = payload.data;
  if (!d?.text || !d.guid || !d.chats?.[0]?.guid) {
    return NextResponse.json({ ok: true, ignored: "incomplete" });
  }
  if (d.isFromMe) {
    return NextResponse.json({ ok: true, ignored: "from_me" });
  }

  const chatGuid = d.chats[0].guid;
  const chatName = d.chats[0].displayName ?? "iMessage chat";
  const senderHandle = d.handle?.address ?? null;
  const msgGuid = d.guid;
  const text = d.text;
  const ts = d.dateCreated ? new Date(d.dateCreated) : new Date();

  // ---- find or self-heal the group row ----
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

  // upsert sender as member
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
        displayName: senderHandle,
      });
    }
  }

  // ---- CLAIM command (handle before the gate; mirrors inc-37 one-owner rules) ----
  const claimMatch = text.match(CLAIM_RE);
  if (claimMatch) {
    const tokenInput = claimMatch[1].toLowerCase();
    const claim = await db.query.claimTokens.findFirst({
      where: and(
        eq(schema.claimTokens.token, tokenInput),
        isNull(schema.claimTokens.usedAt),
        gt(schema.claimTokens.expiresAt, new Date()),
      ),
    });
    if (!claim) {
      await sendBluebubblesMessage(
        chatGuid,
        "❌ That claim code is invalid, expired, or already used. Generate a new one from the dashboard.",
      );
      return NextResponse.json({ ok: true, claim: "invalid" });
    }
    if (group.registeredByUserId !== null) {
      if (group.registeredByUserId === claim.userId) {
        await sendBluebubblesMessage(
          chatGuid,
          "✅ This chat is already connected to your dashboard.",
        );
      } else {
        await sendBluebubblesMessage(
          chatGuid,
          "❌ This chat is already connected to another dashboard. The current owner must disconnect it first.",
        );
      }
      return NextResponse.json({ ok: true, claim: "already_claimed" });
    }
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, claim.userId),
    });
    await db
      .update(schema.groups)
      .set({ registeredByUserId: claim.userId, updatedAt: new Date() })
      .where(eq(schema.groups.id, group.id));
    await db
      .update(schema.claimTokens)
      .set({ usedAt: new Date() })
      .where(eq(schema.claimTokens.id, claim.id));
    const who = user?.name ?? user?.email ?? "user";
    await sendBluebubblesMessage(
      chatGuid,
      `✅ Connected to ${who}'s dashboard. I'm now active in this chat.`,
    );
    return NextResponse.json({ ok: true, claim: "ok" });
  }

  // ---- claim gate: inert until claimed (mirror inc-37) ----
  if (group.registeredByUserId === null) {
    // Post a one-time claim prompt, deduped via claimPromptSentAt.
    if (!group.claimPromptSentAt) {
      await sendBluebubblesMessage(chatGuid, buildClaimPromptMessage());
      await db
        .update(schema.groups)
        .set({ claimPromptSentAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.groups.id, group.id));
    }
    return NextResponse.json({ ok: true, gated: "unclaimed" });
  }

  // ---- claimed: persist + emit ----
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
        raw: { source: "bluebubbles", payload: d as Record<string, unknown> },
      })
      .returning({ id: schema.messages.id });
    messageId = inserted[0].id;
  }

  await inngest.send({
    name: "message.received.ambient",
    data: { groupId: group.id, messageId, text },
  });

  return NextResponse.json({ ok: true });
}
