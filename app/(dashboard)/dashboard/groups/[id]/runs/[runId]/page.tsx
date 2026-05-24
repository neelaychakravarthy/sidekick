import { and, asc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { db, schema } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const { id, runId } = await params;
  const userId = session.user.id;

  const [group, run] = await Promise.all([
    db.query.groups.findFirst({ where: eq(schema.groups.id, id) }),
    db.query.agentRuns.findFirst({ where: eq(schema.agentRuns.id, runId) }),
  ]);
  if (!group || !run || run.groupId !== id) notFound();
  if (group.registeredByUserId && group.registeredByUserId !== userId) {
    notFound();
  }

  // Trigger messages (may be empty if rows were deleted)
  const triggers =
    run.triggerMessageIds.length > 0
      ? await db
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
          .where(inArray(schema.messages.id, run.triggerMessageIds))
          .orderBy(asc(schema.messages.ts))
      : [];

  // Steps in order
  const steps = await db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.agentRunId, runId))
    .orderBy(asc(schema.agentRunSteps.createdAt));

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 md:py-12">
      <Button
        variant="ghost"
        nativeButton={false}
        className="h-11 -ml-3"
        render={<Link href={`/dashboard/groups/${id}`}>← {group.name}</Link>}
      />
      <h1 className="font-heading mt-2 mb-1 text-2xl font-semibold tracking-tight">
        {run.intentSummary ?? "(no summary)"}
      </h1>
      <div className="mb-8 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{new Date(run.createdAt).toLocaleString()}</span>
        <span>·</span>
        <span
          className={
            run.status === "responded"
              ? "text-green-700 dark:text-green-400"
              : run.status === "failed"
                ? "text-destructive"
                : ""
          }
        >
          {run.status}
        </span>
        {run.errorText && (
          <>
            <span>·</span>
            <span className="text-destructive">{run.errorText}</span>
          </>
        )}
      </div>

      <div className="space-y-4">
        {triggers.length > 0 && (
          <StepCard kind="trigger" title="Trigger message(s)" tone="user">
            {triggers.map((t) => (
              <div key={t.id} className="text-sm">
                <div className="text-xs text-muted-foreground">
                  {t.displayName ??
                    (t.telegramUserId
                      ? `user-${t.telegramUserId}`
                      : "unknown")}{" "}
                  · {new Date(t.ts).toLocaleTimeString()}
                </div>
                <div className="mt-1 whitespace-pre-wrap">
                  {t.text ?? "(no text)"}
                </div>
              </div>
            ))}
          </StepCard>
        )}

        {steps.map((s) => (
          <StepRenderer key={s.id} step={s} />
        ))}

        {steps.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No step records for this run (likely predates the step-logging
            increment).
          </p>
        )}
      </div>
    </div>
  );
}

function StepRenderer({
  step,
}: {
  step: typeof schema.agentRunSteps.$inferSelect;
}) {
  const payload = step.payload as Record<string, unknown>;
  const ts = new Date(step.createdAt).toLocaleTimeString();

  switch (step.kind) {
    case "analyzer_decision": {
      return (
        <StepCard
          kind="analyzer_decision"
          title={`Analyzer decision: ${String(payload.decision ?? "?")}`}
          tone="internal"
          ts={ts}
        >
          {payload.intent_summary ? (
            <div className="text-sm">
              <span className="text-muted-foreground">Intent:</span>{" "}
              {String(payload.intent_summary)}
            </div>
          ) : null}
          {Array.isArray(payload.intent_keywords) &&
          payload.intent_keywords.length > 0 ? (
            <div className="mt-1 text-sm">
              <span className="text-muted-foreground">Keywords:</span>{" "}
              {(payload.intent_keywords as string[]).join(", ")}
            </div>
          ) : null}
        </StepCard>
      );
    }
    case "inferred_memory": {
      const facts =
        (payload.facts as Array<{ key: string; value: string }> | undefined) ??
        [];
      return (
        <StepCard
          kind="inferred_memory"
          title={`Inferred ${facts.length} fact${facts.length === 1 ? "" : "s"}`}
          tone="internal"
          ts={ts}
        >
          {facts.length > 0 && (
            <ul className="space-y-1 text-sm">
              {facts.map((f, i) => (
                <li key={i}>
                  <span className="font-mono text-xs text-muted-foreground break-all">
                    {f.key}:
                  </span>{" "}
                  {f.value}
                </li>
              ))}
            </ul>
          )}
        </StepCard>
      );
    }
    case "ack_posted":
      return (
        <StepCard
          kind="ack_posted"
          title="Posted ack to Telegram"
          tone="bot"
          ts={ts}
        >
          <div className="whitespace-pre-wrap text-sm">
            {String(payload.text ?? "")}
          </div>
        </StepCard>
      );
    case "agent_llm_call":
      return (
        <StepCard
          kind="agent_llm_call"
          title={`LLM call · ${String(payload.model ?? "?")}`}
          tone="internal"
          ts={ts}
        >
          <div className="text-sm text-muted-foreground">
            Generating final response…
          </div>
        </StepCard>
      );
    case "response_posted":
      return (
        <StepCard
          kind="response_posted"
          title="Final response posted"
          tone="bot"
          ts={ts}
        >
          <div className="whitespace-pre-wrap text-sm">
            {String(payload.text ?? "")}
          </div>
        </StepCard>
      );
    case "error":
      return (
        <StepCard kind="error" title="Error" tone="error" ts={ts}>
          <div className="whitespace-pre-wrap text-sm text-destructive">
            {String(payload.message ?? "")}
          </div>
        </StepCard>
      );
    case "trigger":
      // already rendered above for completeness — but if a step also logged it, render again
      return (
        <StepCard kind="trigger" title="Trigger" tone="user" ts={ts}>
          <div className="whitespace-pre-wrap text-sm">
            {String(payload.text ?? "")}
          </div>
        </StepCard>
      );
    default:
      return (
        <StepCard
          kind={step.kind as string}
          title={step.kind}
          tone="internal"
          ts={ts}
        >
          <pre className="overflow-x-auto text-xs">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </StepCard>
      );
  }
}

function StepCard({
  title,
  children,
  tone,
  ts,
}: {
  kind: string;
  title: string;
  children: React.ReactNode;
  tone: "user" | "bot" | "internal" | "error";
  ts?: string;
}) {
  const toneClass =
    tone === "user"
      ? "border-l-4 border-l-primary bg-primary/5"
      : tone === "bot"
        ? "border-l-4 border-l-green-500/60 bg-green-500/5"
        : tone === "error"
          ? "border-l-4 border-l-destructive bg-destructive/5"
          : "border-l-4 border-l-muted-foreground/30";
  return (
    <Card className={toneClass}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span>{title}</span>
          {ts && (
            <span className="text-xs font-normal text-muted-foreground">
              {ts}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
