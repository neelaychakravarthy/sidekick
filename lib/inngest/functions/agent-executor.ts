import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { logStep } from "@/lib/agent-steps";
import { ANTHROPIC_MODEL, getAnthropic } from "@/lib/anthropic";
import { db, schema } from "@/lib/db";
import { inngest } from "@/lib/inngest/client";
import { sendMessage, type SendArgs } from "@/lib/messaging";
import { retrieveTopMemories } from "@/lib/memory-retrieval";
import {
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
} from "@/lib/prompts/agent";

const CONTEXT_WINDOW_SIZE = 20;
const CONTEXT_WINDOW_MINUTES = 30;

export const agentExecutor = inngest.createFunction(
  {
    id: "agent-executor",
    name: "Agent executor",
    retries: 3,
    triggers: [{ event: "agent.run-requested" }],
  },
  async ({ event, step, logger }) => {
    const { groupId, runId } = event.data;

    // Update status -> acting
    await step.run("mark-acting", async () => {
      await db
        .update(schema.agentRuns)
        .set({ status: "acting", updatedAt: new Date() })
        .where(eq(schema.agentRuns.id, runId));
    });

    // Load run + group + context
    const cutoff = new Date(Date.now() - CONTEXT_WINDOW_MINUTES * 60_000);

    const ctx = await step.run("load-run-context", async () => {
      const [run, group] = await Promise.all([
        db.query.agentRuns.findFirst({
          where: eq(schema.agentRuns.id, runId),
        }),
        db.query.groups.findFirst({ where: eq(schema.groups.id, groupId) }),
      ]);
      if (!run || !group) {
        throw new Error(`agentRun=${runId} or group=${groupId} not found`);
      }
      const [contextMessages, triggers, rules] = await Promise.all([
        db
          .select({
            text: schema.messages.text,
            ts: schema.messages.ts,
            telegramUserId: schema.messages.telegramUserId,
            displayName: schema.groupMembers.displayName,
            isBot: schema.messages.isBot,
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
        run.triggerMessageIds.length > 0
          ? db
              .select({ text: schema.messages.text })
              .from(schema.messages)
              .where(inArray(schema.messages.id, run.triggerMessageIds))
          : Promise.resolve([] as { text: string | null }[]),
        db
          .select({ ruleText: schema.groupRules.ruleText })
          .from(schema.groupRules)
          .where(eq(schema.groupRules.groupId, groupId))
          .limit(20),
      ]);
      const triggerText = triggers
        .map((t) => t.text ?? "")
        .filter((s) => s.length > 0)
        .join("\n\n");
      return {
        run,
        group,
        contextMessages: contextMessages.reverse(),
        triggerText,
        rules,
      };
    });

    // Semantic memory retrieval — top-K cosine-ranked by trigger text, with
    // recency fallback when embeddings aren't available. Sequenced after
    // load-run-context so we have triggerText.
    const mem = await step.run("retrieve-memory", async () => {
      return retrieveTopMemories(groupId, ctx.triggerText, 10);
    });

    // Re-hydrate Date fields after Inngest step serialization (Dates become ISO strings).
    const contextMessages = ctx.contextMessages.map((m) => ({
      ...m,
      ts: new Date(m.ts as unknown as string | Date),
    }));

    // Post ack message — route by group platform.
    const ackText = `👀 looking into ${ctx.run.intentSummary ?? "this"}…`;
    const ackSendArgs: SendArgs =
      ctx.group.platform === "imessage"
        ? {
            platform: "imessage",
            photonSpaceId: ctx.group.photonSpaceId ?? "",
            groupId: ctx.group.id,
            text: ackText,
          }
        : {
            platform: "telegram",
            telegramChatId: ctx.group.telegramChatId ?? "",
            groupId: ctx.group.id,
            text: ackText,
          };
    const ackResult = await step.run("post-ack", async () => {
      return await sendMessage(ackSendArgs);
    });

    await step.run("save-ack-id", async () => {
      await db
        .update(schema.agentRuns)
        .set({
          ackMessageId: ackResult.externalMessageId,
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, runId));
    });

    await step.run("log-ack-posted", async () => {
      await logStep(runId, "ack_posted", {
        text: ackText,
        telegramMessageId: ackResult.externalMessageId,
      });
    });

    // Call Claude for the final response
    await step.run("log-agent-llm-call", async () => {
      await logStep(runId, "agent_llm_call", { model: ANTHROPIC_MODEL });
    });

    let finalText: string;
    try {
      finalText = await step.run("agent-llm", async () => {
        const client = getAnthropic();
        const resp = await client.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 1024,
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 5,
            },
          ],
          system: buildAgentSystemPrompt(),
          messages: [
            {
              role: "user",
              content: buildAgentUserPrompt({
                groupName: ctx.group.name,
                triggerText: ctx.triggerText,
                intentSummary: ctx.run.intentSummary ?? "",
                contextMessages: contextMessages.map((m) => ({
                  sender:
                    m.displayName ??
                    (m.telegramUserId
                      ? `user-${m.telegramUserId}`
                      : "unknown"),
                  text: m.text ?? "(no text)",
                  ts: m.ts,
                  isBot: m.isBot,
                })),
                groupMemory: mem,
                groupRules: ctx.rules,
              }),
            },
          ],
        });
        return resp.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("");
      });
    } catch (err) {
      logger.error("[agent-executor] LLM call failed", { runId, err });
      await db
        .update(schema.agentRuns)
        .set({
          status: "failed",
          errorText: err instanceof Error ? err.message : String(err),
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, runId));
      await logStep(runId, "error", {
        where: "agent_llm",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // Post final response — route by group platform.
    const replySendArgs: SendArgs =
      ctx.group.platform === "imessage"
        ? {
            platform: "imessage",
            photonSpaceId: ctx.group.photonSpaceId ?? "",
            groupId: ctx.group.id,
            text: finalText,
          }
        : {
            platform: "telegram",
            telegramChatId: ctx.group.telegramChatId ?? "",
            groupId: ctx.group.id,
            text: finalText,
          };
    const replyResult = await step.run("post-response", async () => {
      return await sendMessage(replySendArgs);
    });

    // Mark responded
    await step.run("mark-responded", async () => {
      await db
        .update(schema.agentRuns)
        .set({
          status: "responded",
          responseMessageId: replyResult.externalMessageId,
          reasoning: finalText,
          respondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, runId));
    });

    await step.run("log-response-posted", async () => {
      await logStep(runId, "response_posted", {
        text: finalText,
        telegramMessageId: replyResult.externalMessageId,
      });
    });

    return { runId, status: "responded" };
  },
);
