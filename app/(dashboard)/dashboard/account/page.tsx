import { count, eq } from "drizzle-orm"
import Link from "next/link"
import { redirect } from "next/navigation"

import { auth } from "@/auth"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { db, schema } from "@/lib/db"

import { DeleteAccountForm } from "./delete-form"

export const dynamic = "force-dynamic"

export default async function AccountPage() {
  const session = await auth()
  if (!session?.user?.id) redirect("/signin")

  const userId = session.user.id
  const userEmail = session.user.email ?? "(unknown)"

  // Pull user + counts in parallel
  const [user, groupCount, messageCount, runCount] = await Promise.all([
    db.query.users.findFirst({ where: eq(schema.users.id, userId) }),
    db
      .select({ n: count() })
      .from(schema.groups)
      .where(eq(schema.groups.registeredByUserId, userId))
      .then((r) => r[0]?.n ?? 0),
    db
      .select({ n: count() })
      .from(schema.messages)
      .innerJoin(schema.groups, eq(schema.messages.groupId, schema.groups.id))
      .where(eq(schema.groups.registeredByUserId, userId))
      .then((r) => r[0]?.n ?? 0),
    db
      .select({ n: count() })
      .from(schema.agentRuns)
      .innerJoin(schema.groups, eq(schema.agentRuns.groupId, schema.groups.id))
      .where(eq(schema.groups.registeredByUserId, userId))
      .then((r) => r[0]?.n ?? 0),
  ])

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8 md:py-12">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Account
        </h1>
        <Button
          variant="outline"
          nativeButton={false}
          className="h-10"
          render={<Link href="/dashboard">Back to dashboard</Link>}
        />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>From your Google sign-in.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <Row label="Name" value={user?.name ?? "—"} />
            <Row label="Email" value={userEmail} />
            <Row
              label="Member since"
              value={
                user?.createdAt
                  ? new Date(user.createdAt).toLocaleDateString()
                  : "—"
              }
            />
          </dl>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Your data</CardTitle>
          <CardDescription>What Sidekick has stored for you.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <Stat label="Groups" value={groupCount} />
            <Stat label="Messages observed" value={messageCount} />
            <Stat label="Agent runs" value={runCount} />
          </dl>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Delete your account and ALL data Sidekick has stored for you. This
            wipes your user row, every group you registered, all messages and
            agent runs in those groups, and any pending claim tokens. The bot
            stays in your Telegram groups until you remove it manually — but it
            won&apos;t have a backing record on the web side.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteAccountForm />
        </CardContent>
      </Card>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="sm:col-span-2">{value}</dd>
    </>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      <dt className="mt-1 text-xs text-muted-foreground">{label}</dt>
    </div>
  )
}
