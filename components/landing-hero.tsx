import Link from "next/link"

import { auth } from "@/auth"
import { Button } from "@/components/ui/button"

export async function LandingHero() {
  const session = await auth()

  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-16 md:py-24">
      <div className="flex flex-col items-center text-center">
        <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl md:text-6xl">
          Add a sidekick to your group chat.
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          Sidekick is the AI agent that lives in your Telegram groups — silent
          until you @ it, then quick on polls, plans, and group memory.
        </p>
        <div className="mt-10 flex flex-col items-center gap-3">
          {session?.user ? (
            <Button
              size="lg"
              nativeButton={false}
              className="h-12 px-6 text-base"
              render={<Link href="/dashboard">Go to dashboard</Link>}
            />
          ) : (
            <>
              <Button
                size="lg"
                nativeButton={false}
                className="h-12 px-6 text-base"
                render={<Link href="/signup">Get started</Link>}
              />
              <Link
                href="/signin"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Already have an account? Sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
