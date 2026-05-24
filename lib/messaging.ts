import { db, schema } from "@/lib/db";
import { sendPhotonMessage } from "@/lib/photon/client";
import { bot } from "@/lib/telegram/bot";

export type Platform = "telegram" | "imessage";

export type SendArgs =
  | {
      platform: "telegram";
      telegramChatId: string;
      groupId: string;
      text: string;
    }
  | {
      platform: "imessage";
      photonSpaceId: string;
      groupId: string;
      text: string;
    };

export type SendResult = {
  platform: Platform;
  externalMessageId: string | null;
};

/**
 * Channel-routing send. Dispatches to the Telegram bot or the Photon
 * Spectrum SDK depending on `args.platform`. Returns the external message
 * id (when known) so callers can persist it on `agent_runs`.
 *
 * Also persists the bot's outgoing message to the `messages` table with
 * is_bot=true so the analyzer's sliding context window sees what the bot
 * already said and avoids duplicate / repeated replies.
 */
export async function sendMessage(args: SendArgs): Promise<SendResult> {
  let externalMessageId: string | null = null;

  if (args.platform === "telegram") {
    const sent = await bot.api.sendMessage(
      Number(args.telegramChatId),
      args.text,
    );
    externalMessageId = sent.message_id.toString();
  } else {
    externalMessageId = await sendPhotonMessage(args.photonSpaceId, args.text);
  }

  // Persist the bot's outgoing message so it appears in future context windows.
  // Non-fatal: persistence failure shouldn't break send.
  try {
    const baseValues = {
      groupId: args.groupId,
      platform: args.platform,
      isBot: true,
      text: args.text,
      ts: new Date(),
      raw: { source: "sidekick", externalMessageId } as Record<string, unknown>,
    };
    if (args.platform === "telegram") {
      await db.insert(schema.messages).values({
        ...baseValues,
        telegramMessageId: externalMessageId,
      });
    } else {
      await db.insert(schema.messages).values({
        ...baseValues,
        photonMessageId: externalMessageId,
      });
    }
  } catch (err) {
    console.error("[messaging] failed to persist bot message:", err);
  }

  return { platform: args.platform, externalMessageId };
}
