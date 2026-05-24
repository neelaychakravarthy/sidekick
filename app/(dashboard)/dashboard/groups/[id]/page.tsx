import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { db, schema } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function GroupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const { id } = await params;
  const userId = session.user.id;

  const group = await db.query.groups.findFirst({
    where: eq(schema.groups.id, id),
  });
  if (!group) notFound();
  if (group.registeredByUserId && group.registeredByUserId !== userId) {
    // Group exists but not owned by this user; treat as not found.
    notFound();
  }

  const [runs, memory, rules] = await Promise.all([
    db
      .select({
        id: schema.agentRuns.id,
        status: schema.agentRuns.status,
        intentSummary: schema.agentRuns.intentSummary,
        createdAt: schema.agentRuns.createdAt,
        respondedAt: schema.agentRuns.respondedAt,
        errorText: schema.agentRuns.errorText,
      })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.groupId, id))
      .orderBy(desc(schema.agentRuns.createdAt))
      .limit(50),
    db
      .select()
      .from(schema.groupMemory)
      .where(eq(schema.groupMemory.groupId, id))
      .orderBy(desc(schema.groupMemory.updatedAt)),
    db
      .select()
      .from(schema.groupRules)
      .where(eq(schema.groupRules.groupId, id))
      .orderBy(desc(schema.groupRules.createdAt)),
  ]);

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 md:py-12">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Button
            variant="ghost"
            nativeButton={false}
            className="h-11 -ml-3"
            render={<Link href="/dashboard">← Dashboard</Link>}
          />
          <h1 className="font-heading mt-1 text-3xl font-semibold tracking-tight">
            {group.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            Telegram chat ID: {group.telegramChatId} · Connected{" "}
            {new Date(group.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            {runs.length === 0
              ? "No runs yet. @-mention the bot in this group to trigger one."
              : `${runs.length} total run${runs.length === 1 ? "" : "s"}.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length > 0 && (
            <ul className="space-y-2">
              {runs.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/dashboard/groups/${id}/runs/${r.id}`}
                    className="-mx-3 flex items-start justify-between gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {r.intentSummary ?? "(no summary)"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <StatusBadge status={r.status} hasError={!!r.errorText} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Memory</CardTitle>
            <CardDescription>
              {memory.length === 0
                ? "Empty."
                : `${memory.length} fact${memory.length === 1 ? "" : "s"}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {memory.length > 0 && (
              <ul className="space-y-3 text-sm">
                {memory.map((m) => (
                  <li key={m.id}>
                    <div className="font-mono text-xs text-muted-foreground break-all">
                      {m.key}
                    </div>
                    <div>
                      {typeof m.value === "string"
                        ? m.value
                        : JSON.stringify(m.value)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {m.source}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Rules</CardTitle>
            <CardDescription>
              {rules.length === 0
                ? "No rules set."
                : `${rules.length} rule${rules.length === 1 ? "" : "s"}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {rules.length > 0 && (
              <ul className="space-y-2 text-sm">
                {rules.map((r) => (
                  <li key={r.id}>📜 {r.ruleText}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  hasError,
}: {
  status: string;
  hasError: boolean;
}) {
  const color =
    status === "responded"
      ? "bg-green-500/15 text-green-700 dark:text-green-400"
      : status === "failed" || hasError
        ? "bg-destructive/15 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs ${color}`}>
      {status}
    </span>
  );
}
