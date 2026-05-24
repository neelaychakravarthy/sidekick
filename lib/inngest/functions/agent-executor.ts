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

    // Call Claude for the final response.
    // Note: the `log-agent-llm-call` step that previously ran here (with just
    // {model}) has moved to AFTER the LLM call so we can log the full payload
    // — thinking, prompts, tool uses, raw response — in one row.
    type AgentLlmResult = {
      finalText: string;
      thinkingText: string;
      systemPrompt: string;
      userPrompt: string;
      rawResponseText: string;
      toolUses: Array<{
        name: string;
        query: string;
        results: Array<{ title: string; url: string; snippet: string }>;
      }>;
    };

    let llmResult: AgentLlmResult;
    try {
      llmResult = await step.run("agent-llm", async () => {
        const client = getAnthropic();
        const systemPrompt = buildAgentSystemPrompt();
        const userPrompt = buildAgentUserPrompt({
          groupName: ctx.group.name,
          triggerText: ctx.triggerText,
          intentSummary: ctx.run.intentSummary ?? "",
          contextMessages: contextMessages.map((m) => ({
            sender:
              m.displayName ??
              (m.telegramUserId ? `user-${m.telegramUserId}` : "unknown"),
            text: m.text ?? "(no text)",
            ts: m.ts,
            isBot: m.isBot,
          })),
          groupMemory: mem,
          groupRules: ctx.rules,
        });
        const resp = await client.messages.create({
          model: ANTHROPIC_MODEL,
          // max_tokens bumped from 1024 to leave room for thinking budget
          // + tool-use cycles + final text. 8192 - 5000 = 3192 for output.
          max_tokens: 8192,
          // Extended thinking: surfaces Claude's internal chain-of-thought
          // as separate `thinking` content blocks; interleaves naturally with
          // server-side tool use. Required temp=1.0 (we don't set temperature).
          thinking: { type: "enabled", budget_tokens: 5000 },
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 5,
            },
          ],
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        });

        // Cast each block through `unknown` to a permissive shape — the SDK's
        // typed ContentBlock union is precise but verbose; we just read fields.
        const blocks = resp.content as unknown as Array<
          Record<string, unknown>
        >;

        // Thinking blocks may appear multiple times when thinking continues
        // after tool results. Separator makes the distinct sections readable.
        const thinkingText = blocks
          .filter((b) => b.type === "thinking")
          .map((b) => (typeof b.thinking === "string" ? b.thinking : ""))
          .join("\n\n---\n\n");

        const finalText = blocks
          .filter((b) => b.type === "text")
          .map((b) => (typeof b.text === "string" ? b.text : ""))
          .join("");

        // Pair server_tool_use with web_search_tool_result by index — the API
        // returns them in order with matching tool_use_id, so positional pairing
        // is reliable for our single-tool setup.
        const serverToolUses = blocks.filter(
          (b) => b.type === "server_tool_use",
        );
        const toolResults = blocks.filter(
          (b) => b.type === "web_search_tool_result",
        );
        const toolUses: AgentLlmResult["toolUses"] = [];
        for (let i = 0; i < serverToolUses.length; i++) {
          const use = serverToolUses[i];
          const result = toolResults[i];
          const input = (use.input ?? {}) as Record<string, unknown>;
          const resultContent = result?.content;
          const resultArr = Array.isArray(resultContent) ? resultContent : [];
          toolUses.push({
            name: typeof use.name === "string" ? use.name : "web_search",
            query: typeof input.query === "string" ? input.query : "",
            results: resultArr
              .slice(0, 5)
              .map((r: Record<string, unknown>) => ({
                title: typeof r.title === "string" ? r.title : "(no title)",
                url: typeof r.url === "string" ? r.url : "",
                snippet:
                  typeof r.encrypted_content === "string"
                    ? r.encrypted_content.slice(0, 200)
                    : typeof r.snippet === "string"
                      ? r.snippet.slice(0, 200)
                      : "",
              })),
          });
        }

        // Flattened raw response for readability in the dashboard.
        const rawResponseText = blocks
          .map((b) => {
            if (b.type === "thinking") {
              return `[thinking]\n${typeof b.thinking === "string" ? b.thinking : ""}`;
            }
            if (b.type === "text") {
              return `[text]\n${typeof b.text === "string" ? b.text : ""}`;
            }
            if (b.type === "server_tool_use") {
              const input = (b.input ?? {}) as Record<string, unknown>;
              const q =
                typeof input.query === "string" ? input.query : "";
              return `[web_search] query="${q}"`;
            }
            if (b.type === "web_search_tool_result") {
              const c = b.content;
              const n = Array.isArray(c) ? c.length : 0;
              return `[web_search_result] ${n} results`;
            }
            return `[${String(b.type)}]`;
          })
          .join("\n\n");

        return {
          finalText,
          thinkingText,
          systemPrompt,
          userPrompt,
          rawResponseText,
          toolUses,
        };
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

    const finalText = llmResult.finalText;

    // Log the LLM call AFTER the call with full payload (thinking, prompts,
    // raw response, tool uses, final text). Was a bare {model} placeholder
    // before the call previously; the error handler above covers the failure
    // path so we don't lose visibility on a failed call.
    await step.run("log-agent-llm-call", async () => {
      await logStep(runId, "agent_llm_call", {
        model: ANTHROPIC_MODEL,
        thinking: llmResult.thinkingText,
        system_prompt: llmResult.systemPrompt,
        user_prompt: llmResult.userPrompt,
        raw_response: llmResult.rawResponseText,
        tool_uses: llmResult.toolUses,
        final_text: llmResult.finalText,
      });
    });

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
