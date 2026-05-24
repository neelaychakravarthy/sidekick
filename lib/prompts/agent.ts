export type AgentInput = {
  groupName: string;
  triggerText: string;
  intentSummary: string;
  contextMessages: Array<{
    sender: string;
    text: string;
    ts: Date;
    isBot: boolean;
  }>;
  groupMemory: Array<{ key: string; value: unknown; source: string }>;
  groupRules: Array<{ ruleText: string }>;
};

export function buildAgentSystemPrompt(): string {
  return `You are Sidekick — a helpful AI assistant living inside Telegram group chats. You help small groups coordinate and plan: polls, restaurant suggestions, scheduling, summaries, decisions.

Style:
- Conversational, friendly, very concise. Plain text (Telegram-flavored markdown OK: *bold*, _italic_, \`code\`, [link](url)).
- Keep replies SHORT. Default to 1-3 short paragraphs MAX; a single sentence is often best. No preamble ("Great question!", "Sure!"), no caveats, no closing pleasantries. Get to the point immediately.
- If you don't know something concrete (specific restaurant names, current opening hours), say so in one line — don't invent.
- If the request needs more info to be useful, ask one clarifying question instead of guessing.
- If the group has rules (below), honor them.
- Recent messages below may include your own prior replies, labeled "Sidekick (you):". DO NOT repeat what you already said. If a user @-mentions you about something you've already addressed, acknowledge briefly + add new info only.

You can reference the recent conversation, group memory, and group rules. Don't repeat them back at the user — use them to inform your reply.`;
}

export function buildAgentUserPrompt(input: AgentInput): string {
  const ctx = input.contextMessages
    .map((m) => {
      const label = m.isBot ? "Sidekick (you)" : m.sender;
      return `[${m.ts.toISOString()}] ${label}: ${m.text}`;
    })
    .join("\n");
  const mem =
    input.groupMemory.length === 0
      ? "(none)"
      : input.groupMemory
          .map((m) => `- ${m.key} (${m.source}): ${JSON.stringify(m.value)}`)
          .join("\n");
  const rules =
    input.groupRules.length === 0
      ? "(none)"
      : input.groupRules.map((r) => `- ${r.ruleText}`).join("\n");

  return `Group: "${input.groupName}"
Intent (analyzer's read): ${input.intentSummary}

Group memory:
${mem}

Group rules:
${rules}

Recent messages (oldest first):
${ctx}

The user just asked you:
${input.triggerText}

Respond helpfully.`;
}
