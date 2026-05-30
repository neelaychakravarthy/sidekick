import crypto from "node:crypto"
import Link from "next/link"
import { redirect } from "next/navigation"

import { auth } from "@/auth"
import { Button } from "@/components/ui/button"
import { db, schema } from "@/lib/db"

export const dynamic = "force-dynamic"

export default async function ConnectPage() {
  const session = await auth()
  if (!session?.user?.id) redirect("/signin")

  // Generate fresh token each load (tokens auto-expire; cleanup is later)
  const token = crypto.randomBytes(4).toString("hex")
  const expiresAt = new Date(new Date().getTime() + 30 * 60_000)

  await db.insert(schema.claimTokens).values({
    userId: session.user.id,
    token,
    expiresAt,
  })

  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? "Sidekick_The_Bot"
  const deeplink = `https://t.me/${botUsername}?startgroup=true`
  const claimCommand = `@${botUsername} claim ${token}`
  const botHandle =
    process.env.BLUEBUBBLES_BOT_HANDLE ?? "(Sidekick's iMessage address)"
  const imessageClaimCommand = `claim ${token}`

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8 md:py-12">
      <h1 className="font-heading mb-2 text-3xl font-semibold tracking-tight">
        Connect a group
      </h1>
      <p className="mb-10 text-sm text-muted-foreground">
        Add Sidekick to a Telegram or iMessage group, then send a claim command.
      </p>

      <ol className="space-y-8">
        <Step n={1} title="Add the bot to your group">
          <Button
            nativeButton={false}
            size="lg"
            className="h-12 px-6 text-base"
            render={
              <Link href={deeplink} target="_blank" rel="noreferrer">
                Open Telegram → Add @{botUsername}
              </Link>
            }
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Telegram opens a &quot;Choose a group&quot; dialog. Pick the group
            you want Sidekick in.
          </p>
        </Step>

        <Step n={2} title="In the group, send this command">
          <pre className="overflow-x-auto rounded-md border bg-muted/50 px-4 py-3 text-sm font-mono">
            {claimCommand}
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">
            Token expires at {expiresAt.toLocaleTimeString()}. Single-use —
            refresh this page for a new one.
          </p>
        </Step>

        <Step n={3} title="That's it">
          <p className="text-sm">
            The bot will confirm with a ✅ message. Then refresh your dashboard
            — your group will appear there.
          </p>
          <div className="mt-4">
            <Button
              variant="outline"
              nativeButton={false}
              className="h-11"
              render={<Link href="/dashboard">Back to dashboard</Link>}
            />
          </div>
        </Step>

        <Step n={4} title="Or: connect via iMessage">
          <p className="mb-3 text-sm">
            Message Sidekick at{" "}
            <span className="font-mono font-semibold">{botHandle}</span>{" "}
            (or add that address to an iMessage group), then send the claim
            command in that chat:
          </p>
          <pre className="overflow-x-auto rounded-md border bg-muted/50 px-4 py-3 text-sm font-mono">
            {imessageClaimCommand}
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">
            Same token as above; works for either platform.
          </p>
        </Step>
      </ol>
    </div>
  )
}

function Step({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children: React.ReactNode
}) {
  return (
    <li className="flex gap-4">
      <div className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
        {n}
      </div>
      <div className="flex-1">
        <h2 className="mb-3 font-semibold">{title}</h2>
        {children}
      </div>
    </li>
  )
}
