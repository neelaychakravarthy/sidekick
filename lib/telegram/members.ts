import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

type TelegramFrom = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
};

export function deriveDisplayName(from: TelegramFrom | undefined | null): string {
  if (!from) return "unknown";
  const composed = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  if (composed) return composed;
  if (from.username) return `@${from.username}`;
  return `user-${from.id}`;
}

export function deriveSpeakerSlug(displayName: string): string {
  return (
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join("_")
      .slice(0, 24) || "user"
  );
}

/** Upsert a group member on observed activity. Idempotent; updates lastSeenAt + bumps name/username if changed. */
export async function upsertGroupMember(
  groupId: string,
  from: TelegramFrom | undefined | null,
): Promise<void> {
  if (!from || from.is_bot) return;

  const telegramUserId = from.id.toString();
  const displayName = deriveDisplayName(from);
  const telegramUsername = from.username ?? null;
  const now = new Date();

  // First try update (cheap path for existing members)
  const updated = await db
    .update(schema.groupMembers)
    .set({
      displayName,
      telegramUsername,
      lastSeenAt: now,
    })
    .where(
      and(
        eq(schema.groupMembers.groupId, groupId),
        eq(schema.groupMembers.telegramUserId, telegramUserId),
      ),
    )
    .returning({ id: schema.groupMembers.id });

  if (updated.length === 0) {
    // No existing row — insert. Race-safe via the composite unique index.
    await db
      .insert(schema.groupMembers)
      .values({
        groupId,
        telegramUserId,
        telegramUsername,
        displayName,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing();
  }
}

/** Look up a single member's display name. Returns the fallback if missing. */
export async function lookupDisplayName(
  groupId: string,
  telegramUserId: string | null | undefined,
): Promise<string> {
  if (!telegramUserId) return "unknown";
  const row = await db.query.groupMembers.findFirst({
    where: and(
      eq(schema.groupMembers.groupId, groupId),
      eq(schema.groupMembers.telegramUserId, telegramUserId),
    ),
  });
  return row?.displayName ?? `user-${telegramUserId}`;
}
