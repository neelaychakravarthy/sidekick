"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { db, schema } from "@/lib/db";
import { sendMessage } from "@/lib/messaging";
import { bot } from "@/lib/telegram/bot";

export async function toggleAutoReply(groupId: string, enabled: boolean) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authorized");

  // Verify the user owns this group
  const group = await db.query.groups.findFirst({
    where: eq(schema.groups.id, groupId),
  });
  if (!group || group.registeredByUserId !== session.user.id) {
    throw new Error("Not authorized");
  }

  await db
    .update(schema.groups)
    .set({ autoReplyEnabled: enabled, updatedAt: new Date() })
    .where(eq(schema.groups.id, groupId));

  // Mirror the in-chat `@bot autoreply on|off` confirmation so group
  // members see a signal when the toggle is flipped from the dashboard.
  // Best effort: log and continue on failure (DB update is the source of truth).
  if (group.platform === "telegram" && group.telegramChatId) {
    const text = enabled
      ? "🤖 Auto-reply turned ON from the dashboard. I'll watch every message in this group and chime in when I can help."
      : "🤐 Auto-reply turned OFF from the dashboard. I'll only respond when you @-mention me.";
    try {
      await sendMessage({
        platform: "telegram",
        telegramChatId: group.telegramChatId,
        groupId: group.id,
        text,
      });
    } catch (err) {
      console.error("[toggleAutoReply] sendMessage failed", err);
    }
  }

  revalidatePath(`/dashboard/groups/${groupId}`);
}

export async function disconnectGroupAction(groupId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authorized");

  const group = await db.query.groups.findFirst({
    where: eq(schema.groups.id, groupId),
  });
  if (!group || group.registeredByUserId !== session.user.id) {
    throw new Error("Not authorized");
  }

  // Telegram: leave the chat so users get a clear signal. iMessage has no
  // leave-chat concept; skip and just delete the row.
  if (group.platform === "telegram" && group.telegramChatId) {
    try {
      await bot.api.leaveChat(Number(group.telegramChatId));
    } catch (err) {
      console.error(
        "[disconnectGroup] leaveChat failed",
        group.telegramChatId,
        err,
      );
      // Continue — the row delete proceeds regardless.
    }
  }

  // Cascade-deletes messages, agent_runs, group_members, group_memory, group_rules.
  await db.delete(schema.groups).where(eq(schema.groups.id, groupId));

  revalidatePath("/dashboard");
}
