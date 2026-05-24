import { desc, eq } from "drizzle-orm"
import { Activity, Brain, Users } from "lucide-react"
import Link from "next/link"

import { auth } from "@/auth"
import { ActivityRow } from "@/components/activity-row"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { db, schema } from "@/lib/db"

export const dynamic = "force-dynamic"

export default async function DashboardPage() {
  const session = await auth()
  const userId = session?.user?.id

  // Defense in depth — middleware should have caught this already.
  if (!userId) {
    return <div className="container mx-auto py-12">Not signed in.</div>
  }

  const [userGroups, recentRuns, memoryRows] = await Promise.all([
    db.query.groups.findMany({
      where: eq(schema.groups.registeredByUserId, userId),
      orderBy: [desc(schema.groups.createdAt)],
      limit: 10,
    }),
    db
      .select({
        id: schema.agentRuns.id,
        intentSummary: schema.agentRuns.intentSummary,
        status: schema.agentRuns.status,
        decision: schema.agentRuns.decision,
        errorText: schema.agentRuns.errorText,
        createdAt: schema.agentRuns.createdAt,
        groupId: schema.agentRuns.groupId,
        groupName: schema.groups.name,
      })
      .from(schema.agentRuns)
      .innerJoin(schema.groups, eq(schema.agentRuns.groupId, schema.groups.id))
      .where(eq(schema.groups.registeredByUserId, userId))
      .orderBy(desc(schema.agentRuns.createdAt))
      .limit(5),
    db
      .select({
        id: schema.groupMemory.id,
        key: schema.groupMemory.key,
        source: schema.groupMemory.source,
        groupName: schema.groups.name,
      })
      .from(schema.groupMemory)
      .innerJoin(
        schema.groups,
        eq(schema.groupMemory.groupId, schema.groups.id),
      )
      .where(eq(schema.groups.registeredByUserId, userId))
      .orderBy(desc(schema.groupMemory.updatedAt))
      .limit(5),
  ])

  return (
    <>
      <div className="mb-8 flex items-center justify-between">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Dashboard
        </h1>
        <Button
          variant="ghost"
          nativeButton={false}
          className="h-10"
          render={<Link href="/dashboard/account">Account →</Link>}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-6">
      <Card className="p-6">
        <CardHeader className="gap-3 px-0">
          <div className="flex size-10 items-center justify-center rounded-md bg-muted text-foreground">
            <Users className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-lg">Your groups</CardTitle>
          <CardDescription className="text-sm leading-relaxed">
            {userGroups.length === 0
              ? "No groups yet."
              : `${userGroups.length} connected.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {userGroups.length === 0 ? (
            <Button
              nativeButton={false}
              size="lg"
              className="h-12 px-6 text-base"
              render={
                <Link href="/dashboard/connect">Connect a Telegram group</Link>
              }
            />
          ) : (
            <>
              <ul className="mb-3 space-y-2 text-sm">
                {userGroups.map((g) => (
                  <li key={g.id}>
                    <Link
                      href={`/dashboard/groups/${g.id}`}
                      className="-mx-3 block rounded-md px-3 py-1.5 hover:bg-muted/60"
                    >
                      {g.name}
                    </Link>
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                nativeButton={false}
                className="h-11"
                render={
                  <Link href="/dashboard/connect">Connect another group</Link>
                }
              />
            </>
          )}
        </CardContent>
      </Card>
      <Card className="p-6">
        <CardHeader className="gap-3 px-0">
          <div className="flex size-10 items-center justify-center rounded-md bg-muted text-foreground">
            <Activity className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-lg">Recent activity</CardTitle>
          <CardDescription className="text-sm leading-relaxed">
            {recentRuns.length === 0
              ? "Nothing yet. Once you @SidekickBot in a group, runs appear here."
              : `Last ${recentRuns.length} runs.`}
          </CardDescription>
        </CardHeader>
        {recentRuns.length > 0 && (
          <CardContent className="px-0">
            <ul className="divide-y divide-border">
              {recentRuns.map((r) => (
                <li key={r.id}>
                  <ActivityRow
                    href={`/dashboard/groups/${r.groupId}/runs/${r.id}`}
                    intent={r.intentSummary}
                    decision={r.decision}
                    status={r.status}
                    errorText={r.errorText ?? null}
                    timestamp={new Date(r.createdAt)}
                    groupName={r.groupName}
                  />
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
      <Card className="p-6">
        <CardHeader className="gap-3 px-0">
          <div className="flex size-10 items-center justify-center rounded-md bg-muted text-foreground">
            <Brain className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-lg">Memory</CardTitle>
          <CardDescription className="text-sm leading-relaxed">
            {memoryRows.length === 0
              ? "Empty. Sidekick will remember per-group facts as it learns."
              : `${memoryRows.length} facts stored.`}
          </CardDescription>
        </CardHeader>
        {memoryRows.length > 0 && (
          <CardContent className="px-0">
            <ul className="space-y-2 text-sm">
              {memoryRows.map((m) => (
                <li key={m.id}>
                  <div className="font-medium">{m.key}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.groupName} · {m.source}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
      </div>
    </>
  )
}
