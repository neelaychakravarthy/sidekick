import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { logStep } from "@/lib/agent-steps";
import {
  ANTHROPIC_MODEL,
  buildAnthropicClient,
  resolveAnthropicSelection,
} from "@/lib/anthropic";
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
import { messageMentionsBot } from "@/lib/telegram/bot";

const CONTEXT_WINDOW_SIZE = 20;
const CONTEXT_WINDOW_MINUTES = 30;
const ACTIVE_RUN_STATUSES = ["queued", "analyzing", "acting"] as const;

// Shared handler body. Two Inngest functions (`analyzerMention`,
// `analyzerAmbient`) call this with their respective event streams; the
// `forcedMode` arg encodes the "mention path skips debounce + bypasses the
// per-message mention re-check" rule.
async function runAnalyzer({
  event,
  step,
  logger,
  forcedMode,
}: {
  event: {
    data: {
      groupId: string;
      messageId: string;
      text?: string | null;
      telegramMessageId?: string | null;
      photonMessageId?: string | null;
    };
  };
  // Inngest's `step` and `logger` types are deeply parameterized over the
  // event registry; treat them as opaque here. Both functions pass through
  // their own typed step/logger objects.
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
    sendEvent: (id: string, evt: unknown) => Promise<unknown>;
  };
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  forcedMode?: "mention";
}) {
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

  // Create the agent_runs row at the TOP of the flow so every analyzer
  // invocation is traceable in the activity feed — including SILENT outcomes
  // (non-@-mention or LLM-SILENT). Decision and final status are filled in
  // by whichever branch we fall into below.
  const runId = await step.run("create-agent-run", async () => {
    const inserted = await db
      .insert(schema.agentRuns)
      .values({
        groupId,
        triggerMessageIds: [messageId],
        status: "analyzing",
      })
      .returning({ id: schema.agentRuns.id });
    return inserted[0].id;
  });

  await step.run("log-trigger", async () => {
    await logStep(runId, "trigger", {
      messageId,
      text: text ?? "",
      telegramMessageId: event.data.telegramMessageId,
    });
  });

  // Mode derivation. Mention path is forced from the webhook (no re-check);
  // ambient path derives autoreply vs passive from group settings. iMessage
  // has no @-mention concept so it's always autoreply. Passive mode is
  // observation-only: SILENT decision enforced downstream.
  const wasExplicitlyMentioned = forcedMode === "mention";
  let mode: "mention" | "autoreply" | "passive";
  if (wasExplicitlyMentioned) {
    mode = "mention";
  } else if (
    groupForPlatform.platform === "imessage" ||
    groupForPlatform.autoReplyEnabled
  ) {
    mode = "autoreply";
  } else {
    mode = "passive";
  }

  logger.info("[analyzer] mode resolved", { groupId, messageId, mode });

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
    await step.run("mark-silent-no-group", async () => {
      await db
        .update(schema.agentRuns)
        .set({
          status: "responded",
          decision: "silent",
          reasoning: "group not found",
          respondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, runId));
    });
    return { decision: "SILENT", reason: "no_group", runId };
  }

  // Defensive sanity log: if the webhook tagged this as a mention but the
  // text doesn't actually contain @bot, surface it. The TELEGRAM_BOT_USERNAME
  // env var is what gates this — if unset the webhook treats everything as
  // ambient, so this branch only runs when the env var is configured.
  if (wasExplicitlyMentioned && group.platform === "telegram") {
    const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim() ?? "";
    if (
      botUsername &&
      !messageMentionsBot(text ?? null, botUsername.startsWith("@") ? botUsername.slice(1) : botUsername)
    ) {
      logger.warn("[analyzer] mention-routed event has no @bot in text", {
        groupId,
        messageId,
      });
    }
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

  // Structured form of the context window for the run-detail UI. Duplicates
  // the data that's embedded in the user_prompt as plain text, but the UI
  // can render this richer than parsing the prompt text.
  const contextMessagesForLog = contextMessages.map((m) => ({
    sender:
      m.displayName ??
      (m.telegramUserId ? `user-${m.telegramUserId}` : "unknown"),
    text: m.text ?? "(no text)",
    ts: m.ts.toISOString(),
    isBot: m.isBot,
  }));

  // Pick the right Anthropic key for this group's owner. If they have their
  // own key, this returns it (no per-call rate limit). Else it atomically
  // check+increments the daily free-tier counter — short-circuit if over cap.
  // The step returns a serializable shape; the actual Anthropic client is
  // built outside the step (Anthropic instances don't survive serialization).
  const clientSelection = await step.run("pick-anthropic-client", async () => {
    return await resolveAnthropicSelection(group.registeredByUserId);
  });

  if (clientSelection.source === "rate_limited") {
    const { count, limit } = clientSelection;
    await step.run("mark-rate-limited", async () => {
      await db
        .update(schema.agentRuns)
        .set({
          status: "responded",
          decision: "silent",
          reasoning: `rate limited (free tier daily cap reached, ${count}/${limit})`,
          respondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, runId));
    });
    await step.run("log-rate-limited", async () => {
      await logStep(runId, "error", {
        where: "rate_limit",
        count,
        limit,
      });
    });
    // One-per-UTC-day notice in the group chat. Re-load the group inside the
    // step so the check sees any concurrent update to rateLimitNotifiedAt.
    await step.run("maybe-post-rate-limit-notice", async () => {
      const fresh = await db.query.groups.findFirst({
        where: eq(schema.groups.id, groupId),
      });
      if (!fresh) return;
      const now = new Date();
      const todayUtcMidnight = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          0,
          0,
          0,
          0,
        ),
      );
      const alreadyToday =
        fresh.rateLimitNotifiedAt != null &&
        new Date(fresh.rateLimitNotifiedAt).getTime() >=
          todayUtcMidnight.getTime();
      if (alreadyToday) return;
      const base = process.env.NEXTAUTH_URL ?? "";
      const url = `${base}/dashboard/account`;
      const text = `⚠️ Daily free-tier limit hit (${count}/${limit} calls). Add your Anthropic API key at ${url} to keep using me today, or wait until UTC midnight.`;
      try {
        if (fresh.platform === "imessage") {
          if (!fresh.photonSpaceId) return;
          await sendMessage({
            platform: "imessage",
            photonSpaceId: fresh.photonSpaceId,
            groupId: fresh.id,
            text,
          });
        } else {
          if (!fresh.telegramChatId) return;
          await sendMessage({
            platform: "telegram",
            telegramChatId: fresh.telegramChatId,
            groupId: fresh.id,
            text,
          });
        }
        await db
          .update(schema.groups)
          .set({ rateLimitNotifiedAt: now, updatedAt: now })
          .where(eq(schema.groups.id, fresh.id));
      } catch (err) {
        logger.warn("[analyzer] rate-limit notice send failed", { err });
      }
    });
    return { decision: "SILENT", reason: "rate_limited", runId, count, limit };
  }

  // Call Claude for the decision. The client is built INSIDE this step so
  // the user's plaintext key (when on source:"user") never crosses an
  // Inngest step-checkpoint boundary.
  const llmResult = await step.run("analyzer-llm", async () => {
    const client = await buildAnthropicClient(
      clientSelection,
      group.registeredByUserId,
    );
    const system = buildAnalyzerSystemPrompt();
    const user = buildAnalyzerUserPrompt({
      groupName: group.name,
      triggerText: text ?? "",
      mode,
      contextMessages: contextMessages.map((m) => ({
        sender:
          m.displayName ??
          (m.telegramUserId ? `user-${m.telegramUserId}` : "unknown"),
        text: m.text ?? "(no text)",
        ts: m.ts,
        isBot: m.isBot,
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
      // max_tokens bumped from 1024 to leave room for thinking budget + JSON output.
      max_tokens: 4096,
      // Extended thinking: surfaces Claude's internal chain-of-thought as
      // separate `thinking` content blocks. Required temp=1.0 (we don't set
      // temperature anywhere, default is 1.0).
      thinking: { type: "enabled", budget_tokens: 2000 },
      system,
      messages: [{ role: "user", content: user }],
    });
    const thinkingText = resp.content
      .filter((b: { type: string }) => b.type === "thinking")
      .map((b: { type: string }) =>
        (b as unknown as { type: "thinking"; thinking: string }).thinking ??
        "",
      )
      .join("\n\n");
    const rawText = resp.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string }) =>
        (b as unknown as { type: "text"; text: string }).text ?? "",
      )
      .join("");
    return {
      decision: parseAnalyzerDecision(rawText),
      thinkingText,
      systemPrompt: system,
      userPrompt: user,
      rawText,
    };
  });

  const parsedDecision = llmResult.decision;
  const thinkingText = llmResult.thinkingText;
  const analyzerSystemPrompt = llmResult.systemPrompt;
  const analyzerUserPrompt = llmResult.userPrompt;
  const analyzerRawText = llmResult.rawText;

  // Defensive: passive mode must always be SILENT. Coerce if the LLM ignored
  // the instruction. `inferredFacts` is preserved so memory still gets
  // extracted in the SILENT branch below. The forced-silent reason is also
  // captured so the agent_runs row reflects what happened.
  const forcedSilentReason =
    mode === "passive" && parsedDecision.kind !== "SILENT"
      ? `(forced silent — LLM returned ${parsedDecision.kind} in passive mode)`
      : null;
  const decision = forcedSilentReason
    ? {
        kind: "SILENT" as const,
        inferredFacts: parsedDecision.inferredFacts,
      }
    : parsedDecision;

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

    await step.run("log-inferred-memory", async () => {
      await logStep(runId, "inferred_memory", {
        facts: decision.inferredFacts,
      });
    });
  }

  // Reasoning for the activity-row display. Prefer the actual thinking text
  // (truncated for the column) so SILENT rows are informative instead of a
  // generic placeholder. Empty-thinking fallback keeps the column readable.
  // When coercion forced SILENT in passive mode, surface that prefix.
  const silentReasoning = forcedSilentReason
    ? `${forcedSilentReason}${thinkingText.length > 0 ? ` — ${thinkingText.slice(0, 400)}` : ""}`
    : thinkingText.length > 0
      ? thinkingText.slice(0, 500)
      : "model returned SILENT";

  // Act on the decision.
  if (decision.kind === "SILENT") {
    await step.run("mark-silent-llm", async () => {
      await db
        .update(schema.agentRuns)
        .set({
          status: "responded",
          decision: "silent",
          reasoning: silentReasoning,
          respondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, runId));
    });
    await step.run("log-analyzer-decision-silent", async () => {
      await logStep(runId, "analyzer_decision", {
        decision: "SILENT",
        mode,
        thinking: thinkingText,
        system_prompt: analyzerSystemPrompt,
        user_prompt: analyzerUserPrompt,
        raw_response: analyzerRawText,
        forced_silent_reason: forcedSilentReason,
        context_messages: contextMessagesForLog,
      });
    });
    return { decision: "SILENT", reason: "llm", runId };
  }

  if (decision.kind === "DIRECT_REPLY") {
    const sendResult = await step.run("post-direct-reply", async () => {
      if (group.platform === "imessage") {
        if (!group.photonSpaceId) return { externalMessageId: null };
        return await sendMessage({
          platform: "imessage",
          photonSpaceId: group.photonSpaceId,
          groupId: group.id,
          text: decision.text,
        });
      } else {
        if (!group.telegramChatId) return { externalMessageId: null };
        return await sendMessage({
          platform: "telegram",
          telegramChatId: group.telegramChatId,
          groupId: group.id,
          text: decision.text,
        });
      }
    });
    await step.run("mark-direct-reply", async () => {
      await db
        .update(schema.agentRuns)
        .set({
          status: "responded",
          decision: "direct_reply",
          reasoning: decision.text,
          responseMessageId: sendResult.externalMessageId,
          respondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, runId));
    });
    await step.run("log-analyzer-decision-direct", async () => {
      await logStep(runId, "analyzer_decision", {
        decision: "DIRECT_REPLY",
        mode,
        text: decision.text,
        thinking: thinkingText,
        system_prompt: analyzerSystemPrompt,
        user_prompt: analyzerUserPrompt,
        raw_response: analyzerRawText,
        context_messages: contextMessagesForLog,
      });
    });
    return { decision: "DIRECT_REPLY", runId };
  }

  if (decision.kind === "EXTEND_RUN") {
    // Update this new logging row first.
    await step.run("mark-extend-run", async () => {
      await db
        .update(schema.agentRuns)
        .set({
          status: "responded",
          decision: "extend_run",
          extendsRunId: decision.extendsRunId,
          intentSummary: decision.intentSummary,
          intentKeywords: decision.intentKeywords,
          respondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, runId));
    });
    // Append this trigger message to the existing target run's
    // trigger_message_ids so the executor sees the new ask.
    await step.run("extend-target-run", async () => {
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
    await step.run("log-analyzer-decision-extend", async () => {
      await logStep(runId, "analyzer_decision", {
        decision: "EXTEND_RUN",
        mode,
        extends_run_id: decision.extendsRunId,
        intent_summary: decision.intentSummary,
        intent_keywords: decision.intentKeywords,
        thinking: thinkingText,
        system_prompt: analyzerSystemPrompt,
        user_prompt: analyzerUserPrompt,
        raw_response: analyzerRawText,
        context_messages: contextMessagesForLog,
      });
    });
    await step.run("log-trigger-on-target", async () => {
      await logStep(decision.extendsRunId, "trigger", {
        messageId,
        text: text ?? "",
        telegramMessageId: event.data.telegramMessageId,
      });
    });
    await step.run("log-analyzer-decision-on-target", async () => {
      await logStep(decision.extendsRunId, "analyzer_decision", {
        decision: "EXTEND_RUN",
        mode,
        intent_summary: decision.intentSummary,
        intent_keywords: decision.intentKeywords,
        thinking: thinkingText,
        system_prompt: analyzerSystemPrompt,
        user_prompt: analyzerUserPrompt,
        raw_response: analyzerRawText,
        context_messages: contextMessagesForLog,
      });
    });
    // Re-emit agent.run-requested so the executor picks up the extended context
    await step.sendEvent("re-emit-extended", {
      name: "agent.run-requested",
      data: {
        groupId,
        runId: decision.extendsRunId,
        triggerMessageIds: [messageId],
      },
    });
    return {
      decision: "EXTEND_RUN",
      runId,
      extendsRunId: decision.extendsRunId,
    };
  }

  // NEW_ACTION — promote our analyzer row into the executable run by setting
  // status back to "queued" and filling in intent fields. The executor takes
  // over from here and flips it to "acting" → "responded".
  await step.run("mark-new-action", async () => {
    await db
      .update(schema.agentRuns)
      .set({
        status: "queued",
        decision: "new_action",
        intentSummary: decision.intentSummary,
        intentKeywords: decision.intentKeywords,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentRuns.id, runId));
  });

  await step.run("log-analyzer-decision-new-action", async () => {
    await logStep(runId, "analyzer_decision", {
      decision: decision.kind,
      mode,
      intent_summary: decision.intentSummary,
      intent_keywords: decision.intentKeywords,
      thinking: thinkingText,
      system_prompt: analyzerSystemPrompt,
      user_prompt: analyzerUserPrompt,
      raw_response: analyzerRawText,
      context_messages: contextMessagesForLog,
    });
  });

  await step.sendEvent("emit-run-requested", {
    name: "agent.run-requested",
    data: {
      groupId,
      runId,
      triggerMessageIds: [messageId],
    },
  });

  return { decision: "NEW_ACTION", runId };
}

// Mention path: never debounced. The webhook tagged this event as a mention,
// so the user is expecting a response within seconds. Retries=2 keeps recovery
// fast (vs. ambient's higher retry count).
export const analyzerMention = inngest.createFunction(
  {
    id: "analyzer-mention",
    name: "Analyzer (mention)",
    retries: 2,
    triggers: [{ event: "message.received.mention" }],
  },
  async ({ event, step, logger }) => {
    return runAnalyzer({
      event: event as unknown as Parameters<typeof runAnalyzer>[0]["event"],
      step: step as unknown as Parameters<typeof runAnalyzer>[0]["step"],
      logger: logger as unknown as Parameters<typeof runAnalyzer>[0]["logger"],
      forcedMode: "mention",
    });
  },
);

// Ambient path: debounced per-group. Bursts of messages within 8s of each
// other collapse into a single analyzer run on the LATEST event. The 30s
// timeout backstop ensures we never wait so long that the oldest message
// falls out of the sliding context window (20 msgs / 30 min).
export const analyzerAmbient = inngest.createFunction(
  {
    id: "analyzer-ambient",
    name: "Analyzer (ambient)",
    retries: 2,
    debounce: {
      period: "8s",
      key: "event.data.groupId",
      timeout: "30s",
    },
    triggers: [{ event: "message.received.ambient" }],
  },
  async ({ event, step, logger }) => {
    return runAnalyzer({
      event: event as unknown as Parameters<typeof runAnalyzer>[0]["event"],
      step: step as unknown as Parameters<typeof runAnalyzer>[0]["step"],
      logger: logger as unknown as Parameters<typeof runAnalyzer>[0]["logger"],
    });
  },
);
