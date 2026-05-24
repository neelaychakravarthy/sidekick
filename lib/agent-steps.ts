import { db, schema } from "@/lib/db";

export type StepKind =
  | "trigger"
  | "analyzer_decision"
  | "inferred_memory"
  | "ack_posted"
  | "agent_llm_call"
  | "web_search"
  | "web_fetch"
  | "response_posted"
  | "error";

export async function logStep(
  runId: string,
  kind: StepKind,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.agentRunSteps).values({
    agentRunId: runId,
    kind,
    payload,
  });
}
