import { webhookCallback } from "grammy";

import { bot } from "@/lib/telegram/bot";

const handler = webhookCallback(bot, "std/http", {
  secretToken: process.env.TELEGRAM_WEBHOOK_SECRET,
});

export async function POST(req: Request) {
  // grammy validates X-Telegram-Bot-Api-Secret-Token automatically when secretToken is set.
  // If TELEGRAM_WEBHOOK_SECRET is unset, validation is skipped — warn once.
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
    console.warn(
      "[telegram] TELEGRAM_WEBHOOK_SECRET is not set; webhook accepts requests without signature check. Set it for production.",
    );
  }
  return handler(req);
}

// Cosmetic: respond to GET so a browser visit doesn't 405
export async function GET() {
  return new Response("Sidekick Telegram webhook. POST-only endpoint.", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}
