import { inngest } from "@/lib/inngest/client";

export const agentExecutor = inngest.createFunction(
  {
    id: "agent-executor",
    name: "Agent executor",
    triggers: [{ event: "agent.run-requested" }],
  },
  async ({ event, step, logger }) => {
    logger.info("[agent-executor] run requested", {
      groupId: event.data.groupId,
      runId: event.data.runId,
    });

    // Skeleton: future implementation will
    //   1. update agent_runs.status -> "acting"
    //   2. post acknowledgment message to Telegram ("👀 looking into …")
    //   3. run tool calls (Claude + optional web/maps)
    //   4. post final response to Telegram
    //   5. update agent_runs.status -> "responded" + responded_at
    await step.run("noop", async () => ({ status: "skeleton" }));

    return { status: "skeleton" };
  }
);
