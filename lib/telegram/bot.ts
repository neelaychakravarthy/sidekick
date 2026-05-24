import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { Bot } from "grammy";

import { db, schema } from "@/lib/db";
import { embed, serializeEmbedding } from "@/lib/embeddings";
import { inngest } from "@/lib/inngest/client";
import {
  deriveDisplayName,
  deriveSpeakerSlug,
  upsertGroupMember,
} from "@/lib/telegram/members";

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

      // Look up the group to get its id, then upsert the adding user as a member
      const group = await db.query.groups.findFirst({
        where: eq(schema.groups.telegramChatId, chatId),
      });
      if (group) {
        await upsertGroupMember(group.id, ctx.from);
      }

      // Post intro
      try {
        await ctx.reply(INTRO_MESSAGE);
      } catch (err) {
        console.error("[telegram] failed to post intro message:", err);
      }
    }
  });

  // STOP/START opt-out commands. Whole-message regex with word-boundary
  // anchors so "Stop the meeting" or "I need to stop now" don't trigger.
  const STOP_RE = /^\s*stop\s*$/i;
  const START_RE = /^\s*start\s*$/i;

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

    await upsertGroupMember(group.id, ctx.from);

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

  // Explicit memory commands. Registered AFTER claim and BEFORE the generic
  // message handler so they intercept their specific commands before the
  // catch-all message persistence/Inngest emit path runs.
  const REMEMBER_RE = /(?:@\w+\s+)?\/?remember\s+(.+)/i;
  const RULE_RE = /(?:@\w+\s+)?\/?rule:\s*(.+)/i;

  // Helper: derive a snake_case key from a speaker slug + natural-language text
  function deriveMemoryKey(speakerSlug: string, text: string): string {
    const tail = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join("_");
    const base = `${speakerSlug}_${tail || "fact"}`;
    return base.slice(0, 40);
  }

  bot.hears(RULE_RE, async (ctx) => {
    const chatType = ctx.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") return;

    const ruleText = ctx.match[1].trim();
    if (!ruleText) return;

    const chatId = ctx.chat.id.toString();
    const group = await db.query.groups.findFirst({
      where: eq(schema.groups.telegramChatId, chatId),
    });
    if (!group) return;

    await upsertGroupMember(group.id, ctx.from);

    const displayName = deriveDisplayName(ctx.from);

    await db.insert(schema.groupRules).values({
      groupId: group.id,
      ruleText,
      createdByTelegramUserId: ctx.from?.id?.toString() ?? null,
    });

    await ctx.reply(`📜 Rule added by ${displayName}: ${ruleText}`);
  });

  bot.hears(REMEMBER_RE, async (ctx) => {
    const chatType = ctx.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") return;

    const factText = ctx.match[1].trim();
    if (!factText) return;

    const chatId = ctx.chat.id.toString();
    const group = await db.query.groups.findFirst({
      where: eq(schema.groups.telegramChatId, chatId),
    });
    if (!group) return;

    await upsertGroupMember(group.id, ctx.from);

    const displayName = deriveDisplayName(ctx.from);
    const speakerSlug = deriveSpeakerSlug(displayName);
    const attributedValue = `${displayName}: ${factText}`;
    const key = deriveMemoryKey(speakerSlug, factText);

    // Compute embedding for semantic retrieval (falls back to null if no API
    // key / API failure — read path degrades to recency).
    const vec = await embed(`${key}: ${attributedValue}`);
    const embeddingStr = vec ? serializeEmbedding(vec) : null;

    await db
      .insert(schema.groupMemory)
      .values({
        groupId: group.id,
        key,
        value: attributedValue,
        source: "user-stated" as const,
        embedding: embeddingStr,
      })
      .onConflictDoUpdate({
        target: [schema.groupMemory.groupId, schema.groupMemory.key],
        set: {
          value: sql`excluded.value`,
          source: sql`excluded.source`,
          embedding: sql`excluded.embedding`,
          updatedAt: new Date(),
        },
      });

    await ctx.reply(`🧠 Noted: ${attributedValue}`);
  });

  // STOP: opt this speaker out of message logging in this group.
  bot.hears(STOP_RE, async (ctx) => {
    const chatType = ctx.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") return;
    if (!ctx.from) return;

    const chatId = ctx.chat.id.toString();
    const group = await db.query.groups.findFirst({
      where: eq(schema.groups.telegramChatId, chatId),
    });
    if (!group) return;

    await upsertGroupMember(group.id, ctx.from);

    await db
      .update(schema.groupMembers)
      .set({ optedOutAt: new Date() })
      .where(
        and(
          eq(schema.groupMembers.groupId, group.id),
          eq(schema.groupMembers.telegramUserId, ctx.from.id.toString()),
        ),
      );

    const displayName = deriveDisplayName(ctx.from);
    await ctx.reply(
      `🤫 Got it, ${displayName} — I'll stop logging your messages and won't include them in context. Reply START to resume.`,
    );
  });

  // START: re-enable message logging for this speaker in this group.
  bot.hears(START_RE, async (ctx) => {
    const chatType = ctx.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") return;
    if (!ctx.from) return;

    const chatId = ctx.chat.id.toString();
    const group = await db.query.groups.findFirst({
      where: eq(schema.groups.telegramChatId, chatId),
    });
    if (!group) return;

    await upsertGroupMember(group.id, ctx.from);

    await db
      .update(schema.groupMembers)
      .set({ optedOutAt: null })
      .where(
        and(
          eq(schema.groupMembers.groupId, group.id),
          eq(schema.groupMembers.telegramUserId, ctx.from.id.toString()),
        ),
      );

    const displayName = deriveDisplayName(ctx.from);
    await ctx.reply(
      `👋 Welcome back, ${displayName} — I'll log your messages again.`,
    );
  });

  // New message in a group
  bot.on("message", async (ctx) => {
    const chatType = ctx.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") return;

    const chatId = ctx.chat.id.toString();
    let group = await db.query.groups.findFirst({
      where: eq(schema.groups.telegramChatId, chatId),
    });
    if (!group) {
      // Self-heal: bot is in a group but we have no row (likely the bot was here
      // before we started tracking, or the row was deleted via account wipe).
      // Create one with registeredByUserId=null; user can re-claim from the
      // dashboard.
      const chatTitle = "title" in ctx.chat ? ctx.chat.title : "Unnamed group";
      const inserted = await db
        .insert(schema.groups)
        .values({ telegramChatId: chatId, name: chatTitle })
        .onConflictDoNothing()
        .returning();
      group =
        inserted[0] ??
        (await db.query.groups.findFirst({
          where: eq(schema.groups.telegramChatId, chatId),
        }));
      if (!group) return; // shouldn't happen but guard anyway
    }

    await upsertGroupMember(group.id, ctx.from);

    // Opt-out filter: if the speaker has opted out in this group, don't
    // persist or analyze. Past messages remain (no historical scrub).
    if (ctx.from) {
      const member = await db.query.groupMembers.findFirst({
        where: and(
          eq(schema.groupMembers.groupId, group.id),
          eq(schema.groupMembers.telegramUserId, ctx.from.id.toString()),
        ),
      });
      if (member?.optedOutAt) {
        return;
      }
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

  // Edited message in a group — update the stored row. We don't re-emit
  // message.received: edits are rare and the analyzer already processed the
  // original; re-running would create duplicate ack messages.
  bot.on("edited_message", async (ctx) => {
    const chatType = ctx.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") return;

    const editedMsg = ctx.editedMessage;
    if (!editedMsg) return;

    const chatId = ctx.chat.id.toString();
    let group = await db.query.groups.findFirst({
      where: eq(schema.groups.telegramChatId, chatId),
    });
    if (!group) {
      // Self-heal: same pattern as in bot.on("message").
      const chatTitle = "title" in ctx.chat ? ctx.chat.title : "Unnamed group";
      const inserted = await db
        .insert(schema.groups)
        .values({ telegramChatId: chatId, name: chatTitle })
        .onConflictDoNothing()
        .returning();
      group =
        inserted[0] ??
        (await db.query.groups.findFirst({
          where: eq(schema.groups.telegramChatId, chatId),
        }));
      if (!group) return;
    }

    await upsertGroupMember(group.id, ctx.from);

    // Opt-out filter: edits from opted-out users are also skipped.
    if (ctx.from) {
      const member = await db.query.groupMembers.findFirst({
        where: and(
          eq(schema.groupMembers.groupId, group.id),
          eq(schema.groupMembers.telegramUserId, ctx.from.id.toString()),
        ),
      });
      if (member?.optedOutAt) {
        return;
      }
    }

    await db
      .update(schema.messages)
      .set({
        text: editedMsg.text ?? null,
        raw: ctx.update as unknown as Record<string, unknown>,
      })
      .where(
        and(
          eq(schema.messages.groupId, group.id),
          eq(
            schema.messages.telegramMessageId,
            editedMsg.message_id.toString(),
          ),
        ),
      );
  });
}

if (process.env.NODE_ENV !== "production") globalThis.__sidekick_bot = bot;
