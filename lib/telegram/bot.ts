import { and, eq, gt, isNull } from "drizzle-orm";
import { Bot } from "grammy";

import { db, schema } from "@/lib/db";
import { inngest } from "@/lib/inngest/client";

declare global {
  var __sidekick_bot: Bot | undefined;
}

// Build-time-safe: use a placeholder token if missing.
// grammy's Bot constructor does NOT validate the token — it just stores it.
// Actual API calls (ctx.reply, etc.) are where token validation happens, so
// `next build` succeeds without TELEGRAM_BOT_TOKEN set.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "placeholder:not-a-real-token";

const isCachedBot = globalThis.__sidekick_bot !== undefined;
export const bot = globalThis.__sidekick_bot ?? new Bot(TOKEN);

const INTRO_MESSAGE =
  "Hi! I'm Sidekick. I help groups plan and coordinate — @ me to ask. " +
  "Your messages stay in this group; see [link] for what I store. To opt out, reply STOP.";

// Register handlers only once — skip if we're reusing a cached bot across
// hot reloads / lambda warm starts.
if (!isCachedBot) {
  // Bot added/removed from a group
  bot.on("my_chat_member", async (ctx) => {
    const newStatus = ctx.myChatMember.new_chat_member.status;
    const chatType = ctx.chat.type;

    // Only handle groups / supergroups
    if (chatType !== "group" && chatType !== "supergroup") return;

    if (newStatus === "member" || newStatus === "administrator") {
      const chatId = ctx.chat.id.toString();
      const chatTitle = "title" in ctx.chat ? ctx.chat.title : "Unnamed group";

      // Insert (idempotent on telegram_chat_id unique)
      await db
        .insert(schema.groups)
        .values({
          telegramChatId: chatId,
          name: chatTitle,
          // registeredByUserId stays null — Telegram→Sidekick user mapping is future work
        })
        .onConflictDoNothing();

      // Post intro
      try {
        await ctx.reply(INTRO_MESSAGE);
      } catch (err) {
        console.error("[telegram] failed to post intro message:", err);
      }
    }
  });

  // Claim a group: links the Telegram group to the user who generated the token
  // from the dashboard. Must run BEFORE bot.on("message") — without next() the
  // chain stops, so claim text never falls through to message persistence.
  const CLAIM_RE = /(?:@\w+\s+)?\/?claim\s+([a-zA-Z0-9]+)/i;

  bot.hears(CLAIM_RE, async (ctx) => {
    const chatType = ctx.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") return;

    const matchedToken = ctx.match?.[1];
    if (!matchedToken) return;

    const tokenInput = matchedToken.toLowerCase();
    const chatId = ctx.chat.id.toString();

    // Look up token: must exist, not used, not expired
    const claim = await db.query.claimTokens.findFirst({
      where: and(
        eq(schema.claimTokens.token, tokenInput),
        isNull(schema.claimTokens.usedAt),
        gt(schema.claimTokens.expiresAt, new Date()),
      ),
    });

    if (!claim) {
      await ctx.reply(
        "❌ That claim token is invalid, expired, or already used. Generate a new one from the dashboard.",
      );
      return;
    }

    // Look up the group (must already be registered — bot must be in it)
    const group = await db.query.groups.findFirst({
      where: eq(schema.groups.telegramChatId, chatId),
    });

    if (!group) {
      await ctx.reply(
        "❌ This group isn't registered yet. Make sure I'm a member of the group, then try again.",
      );
      return;
    }

    // Look up the user (for the success message)
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, claim.userId),
    });

    // Link group → user
    await db
      .update(schema.groups)
      .set({ registeredByUserId: claim.userId, updatedAt: new Date() })
      .where(eq(schema.groups.id, group.id));

    // Mark token used
    await db
      .update(schema.claimTokens)
      .set({ usedAt: new Date() })
      .where(eq(schema.claimTokens.id, claim.id));

    const displayName = user?.name ?? user?.email ?? "user";
    await ctx.reply(`✅ Group connected to ${displayName}'s dashboard.`);
  });

  // New message in a group
  bot.on("message", async (ctx) => {
    const chatType = ctx.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") return;

    const chatId = ctx.chat.id.toString();
    const group = await db.query.groups.findFirst({
      where: eq(schema.groups.telegramChatId, chatId),
    });
    if (!group) {
      // Group not registered (race: bot received message before my_chat_member?)
      // Skip persistence; future increment can backfill.
      return;
    }

    const inserted = await db
      .insert(schema.messages)
      .values({
        groupId: group.id,
        telegramMessageId: ctx.msg.message_id.toString(),
        telegramUserId: ctx.from?.id?.toString() ?? null,
        text: ctx.msg.text ?? null,
        ts: new Date(ctx.msg.date * 1000),
        raw: ctx.update as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ id: schema.messages.id });

    // Only emit Inngest event if this is a new message (not a duplicate Telegram retry)
    if (inserted.length > 0) {
      await inngest.send({
        name: "message.received",
        data: {
          groupId: group.id,
          messageId: inserted[0].id,
          telegramMessageId: ctx.msg.message_id.toString(),
          text: ctx.msg.text ?? null,
        },
      });
    }
  });
}

if (process.env.NODE_ENV !== "production") globalThis.__sidekick_bot = bot;
