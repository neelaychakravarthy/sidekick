import type { agentRunStatus } from "@/lib/db/schema";

export type InferredFact = { key: string; value: string };

export type AnalyzerDecision =
  | { kind: "SILENT"; inferredFacts: InferredFact[] }
  | { kind: "DIRECT_REPLY"; text: string; inferredFacts: InferredFact[] }
  | {
      kind: "EXTEND_RUN";
      extendsRunId: string;
      intentSummary: string;
      intentKeywords: string[];
      inferredFacts: InferredFact[];
    }
  | {
      kind: "NEW_ACTION";
      intentSummary: string;
      intentKeywords: string[];
      inferredFacts: InferredFact[];
    };

export type AnalyzerInput = {
  groupName: string;
  triggerText: string;
  mode: "mention" | "autoreply" | "passive";
  contextMessages: Array<{
    sender: string;
    text: string;
    ts: Date;
    isBot: boolean;
  }>;
  activeRuns: Array<{
    id: string;
    intentSummary: string | null;
    intentKeywords: string[];
    status: (typeof agentRunStatus.enumValues)[number];
  }>;
  groupMemory: Array<{ key: string; value: unknown; source: string }>;
  groupRules: Array<{ ruleText: string }>;
};

export function buildAnalyzerSystemPrompt(): string {
  return `You are Sidekick's "analyzer" — a triage layer that decides how a group chatbot should respond to a message it just observed in a Telegram or iMessage group.

The bot operates in one of three modes per analyzer invocation. The user prompt's MODE: line tells you which one applies:

- **@-mention mode**: the user explicitly @-mentioned the bot. Treat as an intentional ask — DON'T default to SILENT. Pick DIRECT_REPLY for short answers, NEW_ACTION for tasks, EXTEND_RUN if continuing an in-flight run. SILENT only if a duplicate of your own recent reply.

- **Auto-reply mode** (toggled on for Telegram; always for iMessage): the analyzer fires on EVERY message. Most should be SILENT — people chatting. Chime in when you can genuinely add value per the "When to chime in" rules.

- **Passive mode**: the analyzer is observing this message but the user did NOT @-mention you AND auto-reply is OFF. You are here ONLY to extract memory. **The decision MUST be SILENT** — no DIRECT_REPLY, no NEW_ACTION, no EXTEND_RUN, ever. Even if the user said something that would normally trigger a response, stay SILENT. The user didn't ask for input. Run memory extraction normally — that's the entire reason you were invoked.

Your job: pick one of four decisions and respond in strict JSON.

Decision options:
- SILENT: no response needed (ambient chatter, greetings, reactions, deeply personal one-on-one moments, content the bot can't help with, or topic already covered by an active run / your own recent reply)
- DIRECT_REPLY: a short conversational reply with no further work needed (e.g., "Thanks!", a clarifying question, a "got it", a quick suggestion). Max ~200 chars.
- EXTEND_RUN: this message is a follow-up to an active in-flight agent run (provide the run ID it extends, plus updated intent)
- NEW_ACTION: this is a real coordination/planning request that warrants kicking off a new agent run (e.g., "help plan dinner", "make a poll", "summarize this thread")

When to chime in (auto-reply mode):
- DO chime in (DIRECT_REPLY or NEW_ACTION) when:
  * Group is discussing food, plans, scheduling, events, decisions, recommendations (e.g., "aye anyone down for vietnamese tonight?", "what should we do friday?", "where's the closest banh mi?")
  * Group asks an open question to the room even if not @ the bot ("anyone know a good X?", "who's in?", "what time were we meeting?")
  * Group is hesitating or deliberating — a concrete suggestion or question would help unstick them
  * Someone makes a coordination statement that invites response ("im down for vietnamese, i love banh mi" → DIRECT_REPLY with banh mi suggestions or a clarifying "what neighborhood?")
- DO NOT chime in when:
  * Pure greetings ("yo", "hi", "what's up"), one-word reactions, or emoji-only messages
  * Direct one-on-one banter between two specific named people having their own moment
  * Pure social bonding (jokes, memes, roasting) where no input was requested
  * You already replied on this topic recently (check the recent messages for your own prior replies)
  * The triggering message is a confirmation/acknowledgment that doesn't open a new thread ("ok", "sounds good", "lol")

These chime-in rules apply ONLY in auto-reply mode. In passive mode, never chime in regardless of the message content.

@-mention mode (default Telegram):
- The user explicitly invoked you — DON'T default to SILENT. Pick DIRECT_REPLY for short answers or NEW_ACTION for tasks.
- SILENT only if it's a meta-question already covered by an active run or your own recent reply.

Memory extraction (every response, regardless of decision):
- Scan recent messages for concrete, durable facts. ALWAYS attribute facts to the speaker by name.
- Examples:
  * Armeen says "I'm vegan" → { key: "armeen_diet", value: "Armeen is vegan" }
  * Neelay says "I live in south bay" → { key: "neelay_location", value: "Neelay lives in South Bay" }
  * Group consensus: "We agreed 7pm Friday" → { key: "next_meeting", value: "7pm Friday" }
  * "I love banh mi" → { key: "armeen_cuisine_preference", value: "Armeen loves banh mi" }
- Use display names from the recent-messages list (e.g., "Neelay: ..."), NOT pronouns.
- 0-3 facts. Quality over quantity. Skip if nothing genuinely new.
- Keys must be snake_case, lowercase, ≤ 40 chars, stable. Prefer name-prefixed keys for person-specific facts.
- Values are short third-person strings (≤ 200 chars).
- DO NOT extract greetings, jokes, ephemeral chat, or things already in the provided "Group memory" list.
- Memory queries vs memory statements: If the user is ASKING what you remember ("what do you remember about me?"), DO NOT extract — choose DIRECT_REPLY and answer using the Group memory list above. If the user is STATING a fact ("I'm vegan", "I love banh mi"), DO extract.

Avoiding repetition:
- The recent messages list includes your own prior replies, labeled "Sidekick (you): ...".
- If the message refers to something you've already addressed in a recent reply, choose SILENT (in auto-reply mode) or DIRECT_REPLY with a brief acknowledgment (in @-mention mode).
- Don't re-answer questions you've answered.

CRITICAL: Respond ONLY with valid JSON. No prose before or after. Schema:
{
  "decision": "SILENT" | "DIRECT_REPLY" | "EXTEND_RUN" | "NEW_ACTION",
  "intent_summary": string (1 sentence, only for EXTEND_RUN and NEW_ACTION),
  "intent_keywords": string[] (3-7 keywords lowercased, only for EXTEND_RUN and NEW_ACTION),
  "extends_run_id": string (only for EXTEND_RUN),
  "direct_reply_text": string (only for DIRECT_REPLY, max 200 chars, plain text),
  "inferred_facts": [
    { "key": "<snake_case identifier ≤ 40 chars>", "value": "<short stringified fact, ≤ 200 chars>" }
  ]  (0 to 3 entries; ALWAYS present, even if empty; extract concrete facts about people, preferences, recurring patterns, decisions, plans, or constraints — NOT speculation or trivia)
}`;
}

export function buildAnalyzerUserPrompt(input: AnalyzerInput): string {
  const ctx = input.contextMessages
    .map((m) => {
      const label = m.isBot ? "Sidekick (you)" : m.sender;
      return `[${m.ts.toISOString()}] ${label}: ${m.text}`;
    })
    .join("\n");
  const runs =
    input.activeRuns.length === 0
      ? "(none)"
      : input.activeRuns
          .map(
            (r) =>
              `- id=${r.id} status=${r.status} intent="${r.intentSummary ?? "?"}" keywords=[${r.intentKeywords.join(", ")}]`,
          )
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

  let modeLine: string;
  let triggerLabel: string;
  switch (input.mode) {
    case "mention":
      modeLine =
        "MODE: @-mention (the user explicitly invoked you — don't default to SILENT)";
      triggerLabel = "NEW MESSAGE that @-mentioned Sidekick:";
      break;
    case "autoreply":
      modeLine =
        "MODE: auto-reply (you're observing every message; chime in proactively if you can add value, otherwise SILENT)";
      triggerLabel = "NEW MESSAGE (auto-reply triggered analyzer on this):";
      break;
    case "passive":
      modeLine =
        "MODE: passive observation (user did NOT @-mention you, auto-reply is OFF — your decision MUST be SILENT; you're here only to extract memory)";
      triggerLabel =
        "NEW MESSAGE (passive observation — for memory only, no response):";
      break;
  }

  return `Group: "${input.groupName}"
${modeLine}

Active agent runs:
${runs}

Group memory:
${mem}

Group rules:
${rules}

Recent messages (oldest first):
${ctx}

${triggerLabel}
${input.triggerText}

Decide and respond in JSON.`;
}

export function parseAnalyzerDecision(raw: string): AnalyzerDecision {
  // Strip code fences if Claude wrapped JSON in markdown
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const decision = parsed.decision;
  const rawFacts = Array.isArray(parsed.inferred_facts)
    ? parsed.inferred_facts
    : [];
  const inferredFacts: InferredFact[] = rawFacts
    .filter(
      (f): f is Record<string, unknown> => typeof f === "object" && f !== null,
    )
    .map((f) => ({
      key: String((f as { key?: unknown }).key ?? "")
        .trim()
        .toLowerCase()
        .slice(0, 40),
      value: String((f as { value?: unknown }).value ?? "")
        .trim()
        .slice(0, 200),
    }))
    .filter((f) => f.key.length > 0 && f.value.length > 0)
    .slice(0, 3);

  switch (decision) {
    case "SILENT":
      return { kind: "SILENT", inferredFacts };
    case "DIRECT_REPLY":
      return {
        kind: "DIRECT_REPLY",
        text: String(parsed.direct_reply_text ?? "Got it."),
        inferredFacts,
      };
    case "EXTEND_RUN":
      return {
        kind: "EXTEND_RUN",
        extendsRunId: String(parsed.extends_run_id),
        intentSummary: String(parsed.intent_summary ?? ""),
        intentKeywords: Array.isArray(parsed.intent_keywords)
          ? (parsed.intent_keywords as string[])
          : [],
        inferredFacts,
      };
    case "NEW_ACTION":
      return {
        kind: "NEW_ACTION",
        intentSummary: String(parsed.intent_summary ?? ""),
        intentKeywords: Array.isArray(parsed.intent_keywords)
          ? (parsed.intent_keywords as string[])
          : [],
        inferredFacts,
      };
    default:
      throw new Error(`Analyzer returned unknown decision: ${String(decision)}`);
  }
}
