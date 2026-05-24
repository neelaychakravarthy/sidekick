import { sendPhotonMessage } from "@/lib/photon/client";
import { bot } from "@/lib/telegram/bot";

export type Platform = "telegram" | "imessage";

export type SendArgs =
  | { platform: "telegram"; telegramChatId: string; text: string }
  | { platform: "imessage"; photonSpaceId: string; text: string };

export type SendResult = {
  platform: Platform;
  externalMessageId: string | null;
};

/**
 * Channel-routing send. Dispatches to the Telegram bot or the Photon
 * Spectrum SDK depending on `args.platform`. Returns the external message
 * id (when known) so callers can persist it on `agent_runs`.
 */
export async function sendMessage(args: SendArgs): Promise<SendResult> {
  if (args.platform === "telegram") {
    const sent = await bot.api.sendMessage(
      Number(args.telegramChatId),
      args.text,
    );
    return {
      platform: "telegram",
      externalMessageId: sent.message_id.toString(),
    };
  }
  const id = await sendPhotonMessage(args.photonSpaceId, args.text);
  return { platform: "imessage", externalMessageId: id };
}
