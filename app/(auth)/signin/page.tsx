import Link from "next/link"

import { signInWithGoogle } from "@/lib/auth-actions"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/theme-toggle"

export default function SignInPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 w-full">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/"
            className="font-heading text-lg font-semibold tracking-tight"
          >
            Sidekick
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="font-heading text-2xl font-semibold tracking-tight">
              Sidekick
            </span>
            <p className="text-sm text-muted-foreground">
              Sign in to manage your groups
            </p>
          </div>
          <form action={signInWithGoogle} className="mt-8">
            <Button
              type="submit"
              size="lg"
              className="h-12 w-full px-6 text-base"
            >
              Continue with Google
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-muted-foreground">
            New here?{" "}
            <Link href="/signup" className="font-medium text-foreground hover:underline">
              Sign up
            </Link>
          </p>
        </div>
      </main>
    </div>
  )
}
