"use server"

import { and, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { auth, signOut } from "@/auth"
import { db, schema } from "@/lib/db"
import { encrypt } from "@/lib/encryption"
import { bot } from "@/lib/telegram/bot"

export async function deleteAccountAction() {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/signin")
  }

  const userId = session.user.id

  // Fetch all Telegram groups this user owns, so we can leave them before
  // the cascade nukes their telegram_chat_ids.
  const ownedTelegramGroups = await db
    .select({ telegramChatId: schema.groups.telegramChatId })
    .from(schema.groups)
    .where(
      and(
        eq(schema.groups.registeredByUserId, userId),
        eq(schema.groups.platform, "telegram"),
      ),
    )

  for (const g of ownedTelegramGroups) {
    if (!g.telegramChatId) continue
    try {
      await bot.api.leaveChat(Number(g.telegramChatId))
    } catch (err) {
      console.error("[deleteAccount] leaveChat failed", g.telegramChatId, err)
      // Continue — best effort.
    }
  }

  // Delete the user row.
  // Cascades (via FK ON DELETE CASCADE):
  //   - accounts.user_id → cascade (Auth.js)
  //   - sessions.user_id → cascade (Auth.js, unused in JWT mode)
  //   - claim_tokens.user_id → cascade
  //   - groups.registered_by_user_id → cascade (after the schema change in this increment)
  //     groups cascade → group_members, messages, agent_runs, group_memory, group_rules
  await db.delete(schema.users).where(eq(schema.users.id, userId))

  // Clear the JWT session cookie. redirectTo lands on the landing page.
  await signOut({ redirectTo: "/" })
}

// Anthropic API keys look like `sk-ant-api03-<long-random-string>`. We accept
// any sk-ant- prefix to stay forward-compatible with new key formats; the
// 30-char floor catches obvious paste mistakes (too short to be a real key).
const ANTHROPIC_KEY_REGEX = /^sk-ant-[a-zA-Z0-9_-]+$/
const ANTHROPIC_KEY_MIN_LENGTH = 30

export async function saveAnthropicKey(
  rawKey: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await auth()
  if (!session?.user?.id) {
    return { success: false, error: "Not authenticated" }
  }

  const trimmed = rawKey.trim()
  if (trimmed.length < ANTHROPIC_KEY_MIN_LENGTH) {
    return {
      success: false,
      error: `Key looks too short. Anthropic keys start with sk-ant- and are typically 100+ chars.`,
    }
  }
  if (!ANTHROPIC_KEY_REGEX.test(trimmed)) {
    return {
      success: false,
      error: `Key format invalid. Expected something like sk-ant-api03-...`,
    }
  }

  const encrypted = encrypt(trimmed)

  await db
    .update(schema.users)
    .set({
      anthropicApiKeyEncrypted: encrypted,
      anthropicApiKeyAddedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, session.user.id))

  revalidatePath("/dashboard/account")
  return { success: true }
}

export async function removeAnthropicKey(): Promise<{ success: true }> {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/signin")
  }

  await db
    .update(schema.users)
    .set({
      anthropicApiKeyEncrypted: null,
      anthropicApiKeyAddedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, session.user.id))

  revalidatePath("/dashboard/account")
  return { success: true }
}
