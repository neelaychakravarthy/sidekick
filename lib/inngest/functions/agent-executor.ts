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
    // — thinking, prompts, raw response, final text — in one row. Per-tool
    // invocations (web_search / web_fetch) are logged as their own timeline
    // rows after `log-agent-llm-call`.
    type ToolCallRecord =
      | {
          kind: "web_search";
          query: string;
          results: Array<{ title: string; url: string; snippet: string }>;
        }
      | {
          kind: "web_fetch";
          url: string;
          content_preview: string;
          retrieved_at: string | null;
        };

    type AgentLlmResult = {
      finalText: string;
      thinkingText: string;
      systemPrompt: string;
      userPrompt: string;
      rawResponseText: string;
      toolCalls: ToolCallRecord[];
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
            {
              type: "web_fetch_20260309",
              name: "web_fetch",
              max_uses: 3,
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

        // Pair server_tool_use blocks with their corresponding tool_result
        // blocks by tool_use_id. Don't rely on positional index — Claude may
        // interleave thinking blocks between the use and the result, and now
        // that we have two distinct tools (web_search + web_fetch) the result
        // ordering isn't 1:1 with a single-type filter.
        const resultsByToolUseId = new Map<string, Record<string, unknown>>();
        for (const b of blocks) {
          if (
            b.type === "web_search_tool_result" ||
            b.type === "web_fetch_tool_result"
          ) {
            const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
            if (id) resultsByToolUseId.set(id, b);
          }
        }

        const toolCalls: ToolCallRecord[] = [];
        for (const b of blocks) {
          if (b.type !== "server_tool_use") continue;
          const name = typeof b.name === "string" ? b.name : "";
          const id = typeof b.id === "string" ? b.id : "";
          const input = (b.input ?? {}) as Record<string, unknown>;
          const result = resultsByToolUseId.get(id);

          if (name === "web_search") {
            const resultContent = result?.content;
            const resultArr = Array.isArray(resultContent) ? resultContent : [];
            toolCalls.push({
              kind: "web_search",
              query: typeof input.query === "string" ? input.query : "",
              results: resultArr
                .slice(0, 8)
                .map((r: Record<string, unknown>) => ({
                  title: typeof r.title === "string" ? r.title : "(no title)",
                  url: typeof r.url === "string" ? r.url : "",
                  snippet:
                    typeof r.encrypted_content === "string"
                      ? r.encrypted_content.slice(0, 300)
                      : typeof r.snippet === "string"
                        ? r.snippet.slice(0, 300)
                        : "",
                })),
            });
          } else if (name === "web_fetch") {
            // web_fetch_tool_result content shape (per SDK): either a
            // WebFetchBlock { content: DocumentBlock, retrieved_at, url } or
            // an error block. Be defensive — the wire shape can vary and we'd
            // rather store an empty preview than throw.
            const url = typeof input.url === "string" ? input.url : "";
            let preview = "";
            let retrievedAt: string | null = null;
            const rc = result?.content;
            if (rc && typeof rc === "object" && !Array.isArray(rc)) {
              const wrapper = rc as Record<string, unknown>;
              if (typeof wrapper.retrieved_at === "string") {
                retrievedAt = wrapper.retrieved_at;
              }
              // Nested DocumentBlock case
              const doc = wrapper.content;
              if (doc && typeof doc === "object" && !Array.isArray(doc)) {
                const docObj = doc as Record<string, unknown>;
                const src = docObj.source as
                  | Record<string, unknown>
                  | undefined;
                if (src && typeof src.data === "string") {
                  preview = src.data.slice(0, 500);
                } else if (typeof docObj.text === "string") {
                  preview = docObj.text.slice(0, 500);
                }
              } else if (typeof wrapper.text === "string") {
                preview = wrapper.text.slice(0, 500);
              }
            } else if (typeof rc === "string") {
              preview = rc.slice(0, 500);
            } else if (Array.isArray(rc)) {
              const textBlock = (rc as Array<Record<string, unknown>>).find(
                (c) => c.type === "text" || c.type === "document",
              );
              if (textBlock) {
                const src = textBlock.source as
                  | Record<string, unknown>
                  | undefined;
                preview = String(
                  textBlock.text ?? src?.data ?? "",
                ).slice(0, 500);
              }
            }
            toolCalls.push({
              kind: "web_fetch",
              url,
              content_preview: preview,
              retrieved_at: retrievedAt,
            });
          }
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
              const name = typeof b.name === "string" ? b.name : "tool";
              if (name === "web_search") {
                const q =
                  typeof input.query === "string" ? input.query : "";
                return `[web_search] query="${q}"`;
              }
              if (name === "web_fetch") {
                const u = typeof input.url === "string" ? input.url : "";
                return `[web_fetch] url="${u}"`;
              }
              return `[${name}]`;
            }
            if (b.type === "web_search_tool_result") {
              const c = b.content;
              const n = Array.isArray(c) ? c.length : 0;
              return `[web_search_result] ${n} results`;
            }
            if (b.type === "web_fetch_tool_result") {
              const c = b.content as Record<string, unknown> | undefined;
              const u =
                c && typeof c.url === "string" ? c.url : "";
              return `[web_fetch_result] ${u}`;
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
          toolCalls,
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
    // raw response, final text). Was a bare {model} placeholder before the
    // call previously; the error handler above covers the failure path so we
    // don't lose visibility on a failed call. Tool calls (web_search /
    // web_fetch) are logged as their own timeline rows below instead of
    // bundled here, so each tool invocation gets its own icon/title/body slot
    // in the dashboard.
    await step.run("log-agent-llm-call", async () => {
      await logStep(runId, "agent_llm_call", {
        model: ANTHROPIC_MODEL,
        thinking: llmResult.thinkingText,
        system_prompt: llmResult.systemPrompt,
        user_prompt: llmResult.userPrompt,
        raw_response: llmResult.rawResponseText,
        final_text: llmResult.finalText,
      });
    });

    // Log each tool invocation as its own timeline row. One step.run wraps
    // the whole loop to avoid spinning up an Inngest step per tool call
    // (which would balloon checkpoints). Multiple inserts inside one step
    // is fine. Inserted in resp.content order so the UI's createdAt sort
    // preserves chronology.
    if (llmResult.toolCalls.length > 0) {
      await step.run("log-tool-calls", async () => {
        for (const tc of llmResult.toolCalls) {
          if (tc.kind === "web_search") {
            await logStep(runId, "web_search", {
              query: tc.query,
              results: tc.results,
            });
          } else {
            await logStep(runId, "web_fetch", {
              url: tc.url,
              content_preview: tc.content_preview,
              retrieved_at: tc.retrieved_at,
            });
          }
        }
      });
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
