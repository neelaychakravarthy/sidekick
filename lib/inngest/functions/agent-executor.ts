import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { ANTHROPIC_MODEL, getAnthropic } from "@/lib/anthropic";
import { db, schema } from "@/lib/db";
import { inngest } from "@/lib/inngest/client";
import {
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
} from "@/lib/prompts/agent";
import { bot } from "@/lib/telegram/bot";

const CONTEXT_WINDOW_SIZE = 20;
const CONTEXT_WINDOW_MINUTES = 30;

export const agentExecutor = inngest.createFunction(
  {
    id: "agent-executor",
    name: "Agent executor",
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
      const [contextMessages, triggers, mem, rules] = await Promise.all([
        db
          .select({
            text: schema.messages.text,
            ts: schema.messages.ts,
            telegramUserId: schema.messages.telegramUserId,
          })
          .from(schema.messages)
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
          .select({
            key: schema.groupMemory.key,
            value: schema.groupMemory.value,
            source: schema.groupMemory.source,
          })
          .from(schema.groupMemory)
          .where(eq(schema.groupMemory.groupId, groupId))
          .limit(50),
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
        mem,
        rules,
      };
    });

    // Re-hydrate Date fields after Inngest step serialization (Dates become ISO strings).
    const contextMessages = ctx.contextMessages.map((m) => ({
      ...m,
      ts: new Date(m.ts as unknown as string | Date),
    }));

    // Post ack message
    const ackText = `👀 looking into ${ctx.run.intentSummary ?? "this"}…`;
    const ack = await step.run("post-ack", async () => {
      return await bot.api.sendMessage(
        Number(ctx.group.telegramChatId),
        ackText,
      );
    });

    await step.run("save-ack-id", async () => {
      await db
        .update(schema.agentRuns)
        .set({
          ackMessageId: ack.message_id.toString(),
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, runId));
    });

    // Call Claude for the final response
    let finalText: string;
    try {
      finalText = await step.run("agent-llm", async () => {
        const client = getAnthropic();
        const resp = await client.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 1024,
          system: buildAgentSystemPrompt(),
          messages: [
            {
              role: "user",
              content: buildAgentUserPrompt({
                groupName: ctx.group.name,
                triggerText: ctx.triggerText,
                intentSummary: ctx.run.intentSummary ?? "",
                contextMessages: contextMessages.map((m) => ({
                  sender: m.telegramUserId ?? "unknown",
                  text: m.text ?? "(no text)",
                  ts: m.ts,
                })),
                groupMemory: ctx.mem,
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
      throw err;
    }

    // Post final response
    const reply = await step.run("post-response", async () => {
      return await bot.api.sendMessage(
        Number(ctx.group.telegramChatId),
        finalText,
      );
    });

    // Mark responded
    await step.run("mark-responded", async () => {
      await db
        .update(schema.agentRuns)
        .set({
          status: "responded",
          responseMessageId: reply.message_id.toString(),
          reasoning: finalText,
          respondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, runId));
    });

    return { runId, status: "responded" };
  },
);
