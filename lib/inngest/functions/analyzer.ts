import { inngest } from "@/lib/inngest/client";

export const analyzer = inngest.createFunction(
  {
    id: "analyzer",
    name: "Analyzer",
    triggers: [{ event: "message.received" }],
  },
  async ({ event, step, logger }) => {
    logger.info("[analyzer] received message", {
      groupId: event.data.groupId,
      messageId: event.data.messageId,
    });

    // Skeleton: future implementation will
    //   1. fetch sliding context window from messages + active agent_runs
    //   2. call Claude to decide SILENT / DIRECT_REPLY / EXTEND_RUN / NEW_ACTION
    //   3. on NEW_ACTION, dedup against active runs (keyword overlap), then
    //      emit "agent.run-requested" via step.sendEvent(...)
    await step.run("noop", async () => ({ status: "skeleton" }));

    return { status: "skeleton", decision: "SILENT" };
  }
);
