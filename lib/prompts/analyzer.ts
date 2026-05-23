import type { agentRunStatus } from "@/lib/db/schema";

export type AnalyzerDecision =
  | { kind: "SILENT" }
  | { kind: "DIRECT_REPLY"; text: string }
  | {
      kind: "EXTEND_RUN";
      extendsRunId: string;
      intentSummary: string;
      intentKeywords: string[];
    }
  | { kind: "NEW_ACTION"; intentSummary: string; intentKeywords: string[] };

export type AnalyzerInput = {
  groupName: string;
  triggerText: string;
  contextMessages: Array<{ sender: string; text: string; ts: Date }>;
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
  return `You are Sidekick's "analyzer" — a triage layer that decides how a Telegram group chatbot should respond to a message that @-mentioned it.

Your job: decide one of four outcomes and respond in strict JSON.

Decision options:
- SILENT: the message doesn't need a response (e.g., greeting only, off-topic, already addressed in an active run)
- DIRECT_REPLY: a short conversational reply with no further work needed (e.g., "Thanks!", a clarifying question, a "got it")
- EXTEND_RUN: this message is a follow-up to an active in-flight agent run (provide the run ID it extends, plus updated intent)
- NEW_ACTION: this is a real coordination/planning request that warrants kicking off a new agent run (e.g., "help plan dinner", "make a poll")

CRITICAL: Respond ONLY with valid JSON. No prose before or after. Schema:
{
  "decision": "SILENT" | "DIRECT_REPLY" | "EXTEND_RUN" | "NEW_ACTION",
  "intent_summary": string (1 sentence, only for EXTEND_RUN and NEW_ACTION),
  "intent_keywords": string[] (3-7 keywords lowercased, only for EXTEND_RUN and NEW_ACTION),
  "extends_run_id": string (only for EXTEND_RUN),
  "direct_reply_text": string (only for DIRECT_REPLY, max 200 chars, plain text)
}`;
}

export function buildAnalyzerUserPrompt(input: AnalyzerInput): string {
  const ctx = input.contextMessages
    .map((m) => `[${m.ts.toISOString()}] ${m.sender}: ${m.text}`)
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

  return `Group: "${input.groupName}"

Active agent runs:
${runs}

Group memory:
${mem}

Group rules:
${rules}

Recent messages (oldest first):
${ctx}

NEW MESSAGE that @-mentioned Sidekick:
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
  switch (decision) {
    case "SILENT":
      return { kind: "SILENT" };
    case "DIRECT_REPLY":
      return {
        kind: "DIRECT_REPLY",
        text: String(parsed.direct_reply_text ?? "Got it."),
      };
    case "EXTEND_RUN":
      return {
        kind: "EXTEND_RUN",
        extendsRunId: String(parsed.extends_run_id),
        intentSummary: String(parsed.intent_summary ?? ""),
        intentKeywords: Array.isArray(parsed.intent_keywords)
          ? (parsed.intent_keywords as string[])
          : [],
      };
    case "NEW_ACTION":
      return {
        kind: "NEW_ACTION",
        intentSummary: String(parsed.intent_summary ?? ""),
        intentKeywords: Array.isArray(parsed.intent_keywords)
          ? (parsed.intent_keywords as string[])
          : [],
      };
    default:
      throw new Error(`Analyzer returned unknown decision: ${String(decision)}`);
  }
}
