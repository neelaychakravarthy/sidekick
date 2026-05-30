// Shared copy for the claim flow. Centralized so the Telegram bot (intro on
// add) and the analyzer (one-time claim nudge on @-mention) stay in sync.

function dashboardUrl(): string {
  return (process.env.NEXTAUTH_URL ?? "https://sidekick.vercel.app").replace(
    /\/$/,
    "",
  );
}

/**
 * Posted when the bot is first added to a group (my_chat_member). Leads with
 * the claim step — the bot is inert until a group is connected to a dashboard.
 */
export function buildIntroMessage(): string {
  return [
    "👋 Hi! I'm Sidekick — I help groups plan and coordinate: food, scheduling, polls, summaries.",
    "",
    "I'm not active in this group yet. To switch me on, someone needs to connect me to their dashboard:",
    `1. Go to ${dashboardUrl()}/dashboard/connect`,
    "2. Generate a claim code",
    "3. Send it here: claim <code>",
    "",
    "Your messages stay in this group. To opt out, reply STOP.",
  ].join("\n");
}

/**
 * Posted ONCE (deduped via groups.claimPromptSentAt) when an unclaimed group
 * @-mentions the bot — a nudge to claim before the bot will respond.
 */
export function buildClaimPromptMessage(): string {
  return [
    "👋 I'm not active in this group yet — I need to be connected to a dashboard before I can help.",
    "",
    `1. Go to ${dashboardUrl()}/dashboard/connect`,
    "2. Generate a claim code",
    "3. Send it here: claim <code>",
    "",
    "I'll stay quiet until then.",
  ].join("\n");
}
