import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";
import { ActivityRow } from "@/components/activity-row";
import { AutoReplyToggle } from "@/components/auto-reply-toggle";
import { DisconnectGroupButton } from "@/components/disconnect-group-button";
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
        decision: schema.agentRuns.decision,
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
      <div className="mb-6">
        <Button
          variant="ghost"
          nativeButton={false}
          className="h-11 -ml-3"
          render={<Link href="/dashboard">← Dashboard</Link>}
        />
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            {group.name}
          </h1>
          <AutoReplyToggle
            groupId={group.id}
            initialEnabled={group.autoReplyEnabled}
            platform={group.platform}
          />
          <DisconnectGroupButton
            groupId={group.id}
            groupName={group.name}
            platform={group.platform}
          />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {group.platform === "imessage" ? "iMessage space" : "Telegram chat"} ·
          Connected {new Date(group.createdAt).toLocaleDateString()}
        </p>
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
            <ul className="divide-y divide-border">
              {runs.map((r) => (
                <li key={r.id}>
                  <ActivityRow
                    href={`/dashboard/groups/${id}/runs/${r.id}`}
                    intent={r.intentSummary}
                    decision={r.decision}
                    status={r.status}
                    errorText={r.errorText ?? null}
                    timestamp={new Date(r.createdAt)}
                  />
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
              <dl className="space-y-3 text-sm">
                {memory.map((m) => (
                  <div key={m.id}>
                    <dt className="font-mono text-xs text-muted-foreground break-all">
                      {m.key}
                    </dt>
                    <dd className="mt-0.5 flex items-baseline gap-2">
                      <span className="flex-1">
                        {typeof m.value === "string"
                          ? m.value
                          : JSON.stringify(m.value)}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {m.source}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
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
              <ul className="space-y-1.5 text-sm">
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
