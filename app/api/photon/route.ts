import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { inngest } from "@/lib/inngest/client";
import { sendMessage } from "@/lib/messaging";

const TOLERANCE_SEC = 5 * 60;
const CLAIM_RE = /^\s*\/?claim\s+([a-zA-Z0-9]+)\s*$/i;
const RULE_RE = /^\s*\/?rule:\s*(.+)/i;
const STOP_RE = /^\s*stop\s*$/i;
const START_RE = /^\s*start\s*$/i;

type PhotonEvent = {
  event: string;
  space?: { id: string; platform: string };
  message?: {
    id: string;
    platform: string;
    direction: string;
    timestamp: string;
    sender?: { id: string; platform: string };
    space?: { id: string; platform: string };
    content?: { type: string; text?: string };
  };
};

function verifySignature(
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  const secret = process.env.PHOTON_SIGNING_SECRET;
  if (!secret) return false;
  const expected =
    "v0=" +
    createHmac("sha256", secret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const event = req.headers.get("x-spectrum-event");
  const timestamp = req.headers.get("x-spectrum-timestamp");
  const signature = req.headers.get("x-spectrum-signature");

  if (!event || !timestamp || !signature) {
    return new Response("missing headers", { status: 400 });
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SEC) {
    return new Response("stale timestamp", { status: 400 });
  }

  if (!verifySignature(rawBody, timestamp, signature)) {
    return new Response("bad signature", { status: 401 });
  }

  let payload: PhotonEvent;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // Future events can branch on payload.event. Today: "messages" only.
  if (payload.event !== "messages" || !payload.message || !payload.space) {
    return new Response("ok", { status: 200 });
  }

  const msg = payload.message;
  const photonSpaceId = payload.space.id;
  const photonSenderId = msg.sender?.id ?? null;
  const text = msg.content?.type === "text" ? (msg.content.text ?? null) : null;

  // Self-heal: insert group if missing.
  let group = await db.query.groups.findFirst({
    where: and(
      eq(schema.groups.platform, "imessage"),
      eq(schema.groups.photonSpaceId, photonSpaceId),
    ),
  });
  if (!group) {
    const inserted = await db
      .insert(schema.groups)
      .values({
        platform: "imessage",
        photonSpaceId,
        name: photonSpaceId, // best we have until a future increment fetches participants
      })
      .onConflictDoNothing()
      .returning();
    group =
      inserted[0] ??
      (await db.query.groups.findFirst({
        where: and(
          eq(schema.groups.platform, "imessage"),
          eq(schema.groups.photonSpaceId, photonSpaceId),
        ),
      }));
    if (!group) return new Response("ok", { status: 200 });
  }

  // Upsert member (best-effort — sender id is typically a phone number, no name)
  if (photonSenderId) {
    const existing = await db.query.groupMembers.findFirst({
      where: and(
        eq(schema.groupMembers.groupId, group.id),
        eq(schema.groupMembers.photonSenderId, photonSenderId),
      ),
    });
    if (!existing) {
      await db
        .insert(schema.groupMembers)
        .values({
          groupId: group.id,
          photonSenderId,
          displayName: photonSenderId, // phone-as-name until a contact-resolution increment lands
        })
        .onConflictDoNothing();
    } else {
      await db
        .update(schema.groupMembers)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.groupMembers.id, existing.id));
    }

    // Opt-out check — re-read because we may have just inserted
    const member = await db.query.groupMembers.findFirst({
      where: and(
        eq(schema.groupMembers.groupId, group.id),
        eq(schema.groupMembers.photonSenderId, photonSenderId),
      ),
    });
    if (member?.optedOutAt) {
      return new Response("ok", { status: 200 });
    }
  }

  // Branch on chat commands BEFORE persisting as a normal message.
  if (text) {
    const claimMatch = text.match(CLAIM_RE);
    if (claimMatch) {
      await handleClaim(group.id, claimMatch[1], photonSpaceId);
      return new Response("ok", { status: 200 });
    }
    const ruleMatch = text.match(RULE_RE);
    if (ruleMatch) {
      await handleRule(group.id, ruleMatch[1].trim(), photonSenderId);
      return new Response("ok", { status: 200 });
    }
    if (STOP_RE.test(text) && photonSenderId) {
      await db
        .update(schema.groupMembers)
        .set({ optedOutAt: new Date() })
        .where(
          and(
            eq(schema.groupMembers.groupId, group.id),
            eq(schema.groupMembers.photonSenderId, photonSenderId),
          ),
        );
      return new Response("ok", { status: 200 });
    }
    if (START_RE.test(text) && photonSenderId) {
      await db
        .update(schema.groupMembers)
        .set({ optedOutAt: null })
        .where(
          and(
            eq(schema.groupMembers.groupId, group.id),
            eq(schema.groupMembers.photonSenderId, photonSenderId),
          ),
        );
      return new Response("ok", { status: 200 });
    }
  }

  // Dedup before insert (no unique index on (group_id, photon_message_id)
  // yet — a future increment can add one and switch to onConflictDoNothing).
  const dup = await db.query.messages.findFirst({
    where: and(
      eq(schema.messages.groupId, group.id),
      eq(schema.messages.photonMessageId, msg.id),
    ),
  });

  const inserted = dup
    ? []
    : await db
        .insert(schema.messages)
        .values({
          groupId: group.id,
          platform: "imessage",
          photonMessageId: msg.id,
          photonSenderId,
          text,
          ts: new Date(msg.timestamp),
          raw: payload as unknown as Record<string, unknown>,
        })
        .returning({ id: schema.messages.id });

  if (inserted.length > 0) {
    // iMessage has no @-mention concept — always route through the ambient
    // (debounced) analyzer path. SILENT decisions filter ambient chatter
    // downstream.
    await inngest.send({
      name: "message.received.ambient",
      data: {
        groupId: group.id,
        messageId: inserted[0].id,
        // legacy field name; holds the iMessage message id when this row is iMessage
        telegramMessageId: msg.id,
        text,
      },
    });
  }

  return new Response("ok", { status: 200 });
}

// Cosmetic: respond to GET so a browser visit doesn't 405
export async function GET() {
  return new Response("Sidekick Photon webhook. POST-only endpoint.", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

// ---- inline handler helpers (mirror lib/telegram/bot.ts logic) ----

async function handleClaim(
  groupId: string,
  token: string,
  photonSpaceId: string,
) {
  const claim = await db.query.claimTokens.findFirst({
    where: and(
      eq(schema.claimTokens.token, token.toLowerCase()),
      isNull(schema.claimTokens.usedAt),
      gt(schema.claimTokens.expiresAt, new Date()),
    ),
  });
  if (!claim) {
    await sendPhotonReplyBestEffort(
      groupId,
      photonSpaceId,
      "That claim token is invalid, expired, or already used.",
    );
    return;
  }
  // Enforce one-owner-at-a-time. A group can only be connected to one
  // dashboard. Re-load the group's owner here (the row was loaded earlier in
  // POST but isn't threaded into this helper) and reject before consuming the
  // token if it's already claimed.
  const owned = await db.query.groups.findFirst({
    where: eq(schema.groups.id, groupId),
    columns: { registeredByUserId: true },
  });
  if (owned && owned.registeredByUserId !== null) {
    if (owned.registeredByUserId === claim.userId) {
      // Same user re-claiming their own group — idempotent, don't consume the token.
      await sendPhotonReplyBestEffort(
        groupId,
        photonSpaceId,
        "This group is already connected to your dashboard.",
      );
    } else {
      // Claimed by someone else — reject without consuming the token.
      await sendPhotonReplyBestEffort(
        groupId,
        photonSpaceId,
        "This group is already connected to another dashboard. The current owner must disconnect it first (Disconnect button on their dashboard), then you can claim it.",
      );
    }
    return;
  }
  await db
    .update(schema.groups)
    .set({ registeredByUserId: claim.userId, updatedAt: new Date() })
    .where(eq(schema.groups.id, groupId));
  await db
    .update(schema.claimTokens)
    .set({ usedAt: new Date() })
    .where(eq(schema.claimTokens.id, claim.id));
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, claim.userId),
  });
  await sendPhotonReplyBestEffort(
    groupId,
    photonSpaceId,
    `Group connected to ${user?.name ?? user?.email ?? "user"}'s dashboard.`,
  );
}

async function handleRule(
  groupId: string,
  ruleText: string,
  photonSenderId: string | null,
) {
  if (!ruleText) return;
  await db.insert(schema.groupRules).values({
    groupId,
    ruleText,
    // Legacy column name; holds the Photon sender id when set via iMessage.
    createdByTelegramUserId: photonSenderId,
  });
}

async function sendPhotonReplyBestEffort(
  groupId: string,
  spaceId: string,
  text: string,
): Promise<void> {
  try {
    await sendMessage({
      platform: "imessage",
      photonSpaceId: spaceId,
      groupId,
      text,
    });
  } catch (err) {
    console.error("[photon] failed to send reply:", err);
  }
}
