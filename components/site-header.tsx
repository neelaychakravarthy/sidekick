import Link from "next/link"

import { auth } from "@/auth"
import { signOutAction } from "@/lib/auth-actions"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/theme-toggle"

export async function SiteHeader() {
  const session = await auth()

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="font-heading text-lg font-semibold tracking-tight"
        >
          Sidekick
        </Link>
        <div className="flex items-center gap-2">
          {session?.user ? (
            <>
              <span className="hidden sm:inline text-sm text-muted-foreground">
                {session.user.email}
              </span>
              <form action={signOutAction}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="submit"
                  className="h-11 px-4"
                >
                  Sign out
                </Button>
              </form>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                className="h-11 px-4"
                render={<Link href="/signin">Sign in</Link>}
              />
              <Button
                size="sm"
                nativeButton={false}
                className="h-11 px-4"
                render={<Link href="/signup">Sign up</Link>}
              />
            </>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
