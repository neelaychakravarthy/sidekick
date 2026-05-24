import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { logStep } from "@/lib/agent-steps";
import { ANTHROPIC_MODEL, getAnthropic } from "@/lib/anthropic";
import { db, schema } from "@/lib/db";
import { embed, serializeEmbedding } from "@/lib/embeddings";
import { inngest } from "@/lib/inngest/client";
import { sendMessage } from "@/lib/messaging";
import { retrieveTopMemories } from "@/lib/memory-retrieval";
import {
  buildAnalyzerSystemPrompt,
  buildAnalyzerUserPrompt,
  parseAnalyzerDecision,
} from "@/lib/prompts/analyzer";
import { bot } from "@/lib/telegram/bot";

const CONTEXT_WINDOW_SIZE = 20;
const CONTEXT_WINDOW_MINUTES = 30;
const ACTIVE_RUN_STATUSES = ["queued", "analyzing", "acting"] as const;

function getBotUsernameFromEnv(): string | null {
  const v = process.env.TELEGRAM_BOT_USERNAME?.trim();
  if (!v) return null;
  return v.startsWith("@") ? v.slice(1) : v;
}

let cachedBotUsername: string | null = null;
async function resolveBotUsername(): Promise<string> {
  if (cachedBotUsername) return cachedBotUsername;
  const fromEnv = getBotUsernameFromEnv();
  if (fromEnv) {
    cachedBotUsername = fromEnv;
    return cachedBotUsername;
  }
  // Fall back to bot.api.getMe() — Telegram round-trip, cache forever.
  const me = await bot.api.getMe();
  cachedBotUsername = me.username;
  return cachedBotUsername;
}

function messageMentionsBot(text: string | null, botUsername: string): boolean {
  if (!text) return false;
  // Match "@username" case-insensitively; word-boundary on the right.
  const re = new RegExp(`@${botUsername}\\b`, "i");
  return re.test(text);
}

export const analyzer = inngest.createFunction(
  {
    id: "analyzer",
    name: "Analyzer",
    retries: 3,
    triggers: [{ event: "message.received" }],
  },
  async ({ event, step, logger }) => {
    const { groupId, messageId, text } = event.data;

    // Look up the group early — its platform decides whether we run the
    // Telegram-only mention check. iMessage has no "bot username" concept,
    // so every message is a potential analyzer trigger; the analyzer's
    // own SILENT decision filters out noise downstream.
    const groupForPlatform = await step.run("load-group-platform", async () => {
      return db.query.groups.findFirst({ where: eq(schema.groups.id, groupId) });
    });
    if (!groupForPlatform) {
      return { decision: "SILENT", reason: "no_group" };
    }

    if (groupForPlatform.platform === "telegram") {
      // Skip non-@-mention messages early (MVP behavior; proactive intervention is V2).
      const botUsername = await step.run("resolve-bot-username", () =>
        resolveBotUsername(),
      );
      if (!messageMentionsBot(text, botUsername)) {
        return { decision: "SILENT", reason: "no_mention" };
      }
    }

    logger.info("[analyzer] bot @-mentioned", { groupId, messageId });

    // Pull context: last N messages (capped by N min), active agent_runs, memory, rules, group meta.
    const cutoff = new Date(Date.now() - CONTEXT_WINDOW_MINUTES * 60_000);

    const loaded = await step.run("load-context", async () => {
      const [grp, msgs, runs, rules] = await Promise.all([
        db.query.groups.findFirst({ where: eq(schema.groups.id, groupId) }),
        db
          .select({
            id: schema.messages.id,
            text: schema.messages.text,
            ts: schema.messages.ts,
            telegramUserId: schema.messages.telegramUserId,
            displayName: schema.groupMembers.displayName,
          })
          .from(schema.messages)
          .leftJoin(
            schema.groupMembers,
            and(
              eq(schema.groupMembers.groupId, schema.messages.groupId),
              eq(
                schema.groupMembers.telegramUserId,
                schema.messages.telegramUserId,
              ),
            ),
          )
          .where(
            and(
              eq(schema.messages.groupId, groupId),
              gte(schema.messages.ts, cutoff),
            ),
          )
          .orderBy(desc(schema.messages.ts))
          .limit(CONTEXT_WINDOW_SIZE),
        db
          .select({
            id: schema.agentRuns.id,
            status: schema.agentRuns.status,
            intentSummary: schema.agentRuns.intentSummary,
            intentKeywords: schema.agentRuns.intentKeywords,
          })
          .from(schema.agentRuns)
          .where(
            and(
              eq(schema.agentRuns.groupId, groupId),
              inArray(schema.agentRuns.status, ACTIVE_RUN_STATUSES),
            ),
          )
          .orderBy(desc(schema.agentRuns.createdAt))
          .limit(5),
        db
          .select({ ruleText: schema.groupRules.ruleText })
          .from(schema.groupRules)
          .where(eq(schema.groupRules.groupId, groupId))
          .limit(20),
      ]);
      return {
        group: grp,
        contextMessages: msgs.reverse(),
        activeRuns: runs,
        groupRules: rules,
      };
    });

    const group = loaded.group;
    if (!group) {
      logger.warn("[analyzer] group not found, skipping", { groupId });
      return { decision: "SILENT", reason: "no_group" };
    }

    // Semantic memory retrieval — top-K cosine-ranked by trigger text, with
    // recency fallback when embeddings aren't available. Run as a separate
    // step so the embedding API call gets Inngest retry semantics.
    const groupMemory = await step.run("retrieve-memory", async () => {
      return retrieveTopMemories(groupId, text ?? "", 8);
    });

    // Re-hydrate Date fields after Inngest step serialization (Dates become ISO strings).
    const contextMessages = loaded.contextMessages.map((m) => ({
      ...m,
      ts: new Date(m.ts as unknown as string | Date),
    }));

    // Call Claude for the decision.
    const decision = await step.run("analyzer-llm", async () => {
      const client = getAnthropic();
      const system = buildAnalyzerSystemPrompt();
      const user = buildAnalyzerUserPrompt({
        groupName: group.name,
        triggerText: text ?? "",
        contextMessages: contextMessages.map((m) => ({
          sender:
            m.displayName ??
            (m.telegramUserId ? `user-${m.telegramUserId}` : "unknown"),
          text: m.text ?? "(no text)",
          ts: m.ts,
        })),
        activeRuns: loaded.activeRuns.map((r) => ({
          id: r.id,
          intentSummary: r.intentSummary,
          intentKeywords: r.intentKeywords,
          status: r.status,
        })),
        groupMemory,
        groupRules: loaded.groupRules,
      });
      const resp = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      });
      const rawText = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
      return parseAnalyzerDecision(rawText);
    });

    logger.info("[analyzer] decision", { decision: decision.kind, groupId });

    // Persist inferred memory facts regardless of decision branch.
    if (decision.inferredFacts.length > 0) {
      await step.run("persist-inferred-memory", async () => {
        // Compute embeddings in parallel — falls back to null if no API key / failure
        const factsWithEmbeddings = await Promise.all(
          decision.inferredFacts.map(async (f) => {
            const vec = await embed(`${f.key}: ${f.value}`);
            return {
              groupId,
              key: f.key,
              value: f.value, // jsonb accepts strings as a JSON value
              source: "inferred" as const,
              embedding: vec ? serializeEmbedding(vec) : null,
            };
          }),
        );

        await db
          .insert(schema.groupMemory)
          .values(factsWithEmbeddings)
          .onConflictDoUpdate({
            target: [schema.groupMemory.groupId, schema.groupMemory.key],
            set: {
              value: sql`excluded.value`,
              source: sql`excluded.source`,
              embedding: sql`excluded.embedding`,
              updatedAt: new Date(),
            },
          });
      });
    }

    // Act on the decision.
    if (decision.kind === "SILENT") {
      return { decision: "SILENT", reason: "llm" };
    }

    if (decision.kind === "DIRECT_REPLY") {
      await step.run("post-direct-reply", async () => {
        if (group.platform === "imessage") {
          if (!group.photonSpaceId) return;
          await sendMessage({
            platform: "imessage",
            photonSpaceId: group.photonSpaceId,
            text: decision.text,
          });
        } else {
          if (!group.telegramChatId) return;
          await sendMessage({
            platform: "telegram",
            telegramChatId: group.telegramChatId,
            text: decision.text,
          });
        }
      });
      return { decision: "DIRECT_REPLY" };
    }

    if (decision.kind === "EXTEND_RUN") {
      // Append this trigger message to the existing run's trigger_message_ids
      await step.run("extend-run", async () => {
        await db
          .update(schema.agentRuns)
          .set({
            triggerMessageIds: sql`array_append(${schema.agentRuns.triggerMessageIds}, ${messageId})`,
            intentSummary: decision.intentSummary,
            intentKeywords: decision.intentKeywords,
            updatedAt: new Date(),
          })
          .where(eq(schema.agentRuns.id, decision.extendsRunId));
      });
      await step.run("log-trigger", async () => {
        await logStep(decision.extendsRunId, "trigger", {
          messageId,
          text: text ?? "",
          telegramMessageId: event.data.telegramMessageId,
        });
      });
      await step.run("log-analyzer-decision", async () => {
        await logStep(decision.extendsRunId, "analyzer_decision", {
          decision: "EXTEND_RUN",
          intent_summary: decision.intentSummary,
          intent_keywords: decision.intentKeywords,
        });
      });
      if (decision.inferredFacts.length > 0) {
        await step.run("log-inferred-memory", async () => {
          await logStep(decision.extendsRunId, "inferred_memory", {
            facts: decision.inferredFacts,
          });
        });
      }
      // Re-emit agent.run-requested so the executor picks up the extended context
      await step.sendEvent("re-emit-extended", {
        name: "agent.run-requested",
        data: {
          groupId,
          runId: decision.extendsRunId,
          triggerMessageIds: [messageId],
        },
      });
      return { decision: "EXTEND_RUN", runId: decision.extendsRunId };
    }

    // NEW_ACTION
    const newRunId = await step.run("create-agent-run", async () => {
      const inserted = await db
        .insert(schema.agentRuns)
        .values({
          groupId,
          triggerMessageIds: [messageId],
          status: "queued",
          intentSummary: decision.intentSummary,
          intentKeywords: decision.intentKeywords,
        })
        .returning({ id: schema.agentRuns.id });
      return inserted[0].id;
    });

    await step.run("log-trigger", async () => {
      await logStep(newRunId, "trigger", {
        messageId,
        text: text ?? "",
        telegramMessageId: event.data.telegramMessageId,
      });
    });
    await step.run("log-analyzer-decision", async () => {
      await logStep(newRunId, "analyzer_decision", {
        decision: decision.kind,
        intent_summary: decision.intentSummary,
        intent_keywords: decision.intentKeywords,
      });
    });
    if (decision.inferredFacts.length > 0) {
      await step.run("log-inferred-memory", async () => {
        await logStep(newRunId, "inferred_memory", {
          facts: decision.inferredFacts,
        });
      });
    }

    await step.sendEvent("emit-run-requested", {
      name: "agent.run-requested",
      data: {
        groupId,
        runId: newRunId,
        triggerMessageIds: [messageId],
      },
    });

    return { decision: "NEW_ACTION", runId: newRunId };
  },
);
