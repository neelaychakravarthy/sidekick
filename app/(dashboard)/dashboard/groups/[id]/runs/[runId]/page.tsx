import { and, asc, eq, inArray } from "drizzle-orm";
import {
  Activity,
  AlertCircle,
  Brain,
  Cpu,
  MessageCircle,
  MessageSquare,
  Sparkles,
  User,
} from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";
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
  const triggerSteps =
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

  const meta = run.respondedAt
    ? `Responded ${new Date(run.respondedAt).toLocaleString()}`
    : `Started ${new Date(run.createdAt).toLocaleString()}`;

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 md:py-12">
      {/* Sticky header — sits below the site header (h-16). */}
      <div className="sticky top-16 -mx-4 mb-8 border-b border-border bg-background/95 px-4 py-4 backdrop-blur z-10">
        <Link
          href={`/dashboard/groups/${id}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← {group.name}
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <DecisionBadge
            decision={run.decision}
            status={run.status}
            errorText={run.errorText ?? null}
          />
          <h1 className="font-heading flex-1 truncate text-lg font-semibold tracking-tight">
            {run.intentSummary ?? "(no summary)"}
          </h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{meta}</p>
        {run.errorText && (
          <p className="mt-2 text-xs text-destructive">{run.errorText}</p>
        )}
      </div>

      {/* Timeline */}
      <div className="divide-y divide-border">
        {triggerSteps.map((t) => (
          <TimelineRow
            key={t.id}
            icon={<User className="size-4" />}
            iconTone="bg-primary/15 text-primary"
            title={`${
              t.displayName ??
              (t.telegramUserId ? `user-${t.telegramUserId}` : "user")
            } said`}
            timestamp={new Date(t.ts).toLocaleTimeString()}
          >
            <div className="whitespace-pre-wrap text-sm">
              {t.text ?? "(no text)"}
            </div>
          </TimelineRow>
        ))}

        {steps.map((s) => (
          <StepTimelineRow key={s.id} step={s} runReasoning={run.reasoning} />
        ))}

        {steps.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No step records for this run (likely predates the step-logging
            increment).
          </p>
        )}
      </div>
    </div>
  );
}

function TimelineRow({
  icon,
  iconTone,
  title,
  timestamp,
  children,
}: {
  icon: React.ReactNode;
  iconTone: string;
  title: string;
  timestamp: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 py-4">
      <div
        className={`flex size-8 flex-shrink-0 items-center justify-center rounded-full ${iconTone}`}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="truncate text-sm font-medium">{title}</h3>
          <span className="flex-shrink-0 text-xs text-muted-foreground">
            {timestamp}
          </span>
        </div>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}

const STEP_CONFIG: Record<
  string,
  { icon: React.ReactNode; tone: string; title: string }
> = {
  trigger: {
    icon: <User className="size-4" />,
    tone: "bg-primary/15 text-primary",
    title: "Trigger",
  },
  analyzer_decision: {
    icon: <Brain className="size-4" />,
    tone: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
    title: "Analyzer",
  },
  inferred_memory: {
    icon: <Sparkles className="size-4" />,
    tone: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400",
    title: "Inferred memory",
  },
  ack_posted: {
    icon: <MessageCircle className="size-4" />,
    tone: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    title: "Posted ack",
  },
  agent_llm_call: {
    icon: <Cpu className="size-4" />,
    tone: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
    title: "Agent LLM call",
  },
  response_posted: {
    icon: <MessageSquare className="size-4" />,
    tone: "bg-green-500/15 text-green-700 dark:text-green-400",
    title: "Posted response",
  },
  error: {
    icon: <AlertCircle className="size-4" />,
    tone: "bg-destructive/15 text-destructive",
    title: "Error",
  },
  default: {
    icon: <Activity className="size-4" />,
    tone: "bg-muted text-muted-foreground",
    title: "Step",
  },
};

function StepTimelineRow({
  step,
  runReasoning,
}: {
  step: typeof schema.agentRunSteps.$inferSelect;
  runReasoning: string | null;
}) {
  const payload = step.payload as Record<string, unknown>;
  const ts = new Date(step.createdAt).toLocaleTimeString();

  const config = STEP_CONFIG[step.kind] ?? STEP_CONFIG.default;

  let body: React.ReactNode = null;
  switch (step.kind) {
    case "trigger": {
      body = (
        <div className="whitespace-pre-wrap text-sm">
          {String(payload.text ?? "")}
        </div>
      );
      break;
    }
    case "analyzer_decision": {
      const decision = String(payload.decision ?? "?");
      const intent = payload.intent_summary
        ? String(payload.intent_summary)
        : null;
      const kw = Array.isArray(payload.intent_keywords)
        ? (payload.intent_keywords as string[])
        : [];
      body = (
        <div className="text-sm">
          <div>
            <span className="text-muted-foreground">Decision:</span>{" "}
            <span className="font-medium">{decision}</span>
          </div>
          {intent && (
            <div className="mt-0.5">
              <span className="text-muted-foreground">Intent:</span> {intent}
            </div>
          )}
          {kw.length > 0 && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {kw.join(" · ")}
            </div>
          )}
        </div>
      );
      break;
    }
    case "inferred_memory": {
      const facts =
        (payload.facts as Array<{ key: string; value: string }> | undefined) ??
        [];
      body =
        facts.length > 0 ? (
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
        ) : (
          <div className="text-sm text-muted-foreground">
            No facts extracted
          </div>
        );
      break;
    }
    case "ack_posted":
    case "response_posted": {
      body = (
        <div className="whitespace-pre-wrap text-sm">
          {String(payload.text ?? "")}
        </div>
      );
      break;
    }
    case "agent_llm_call": {
      body = (
        <div className="text-sm text-muted-foreground">
          <div>{String(payload.model ?? "claude")} · generating response…</div>
          {runReasoning && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs hover:text-foreground">
                Show final response
              </summary>
              <div className="mt-2 whitespace-pre-wrap text-sm text-foreground">
                {runReasoning}
              </div>
            </details>
          )}
        </div>
      );
      break;
    }
    case "error": {
      body = (
        <div className="whitespace-pre-wrap text-sm text-destructive">
          {String(payload.message ?? "(no message)")}
        </div>
      );
      break;
    }
    default:
      body = (
        <pre className="overflow-x-auto text-xs">
          {JSON.stringify(payload, null, 2)}
        </pre>
      );
  }

  return (
    <TimelineRow
      icon={config.icon}
      iconTone={config.tone}
      title={config.title}
      timestamp={ts}
    >
      {body}
    </TimelineRow>
  );
}

function DecisionBadge({
  decision,
  status,
  errorText,
}: {
  decision: string | null;
  status: string;
  errorText: string | null;
}) {
  if (errorText || status === "failed") {
    return (
      <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive">
        failed
      </span>
    );
  }
  const tone =
    decision === "silent"
      ? "bg-muted text-muted-foreground"
      : decision === "direct_reply"
        ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
        : decision === "new_action"
          ? "bg-green-500/15 text-green-700 dark:text-green-400"
          : decision === "extend_run"
            ? "bg-purple-500/15 text-purple-700 dark:text-purple-400"
            : "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {decision ?? status}
    </span>
  );
}
