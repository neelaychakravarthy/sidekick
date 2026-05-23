import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export function LandingHero() {
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
        <div className="mt-10">
          <TooltipProvider delay={150}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-block pointer-events-auto">
                    <Button
                      disabled
                      size="lg"
                      className="h-12 px-6 text-base"
                    >
                      Connect a Telegram group
                    </Button>
                  </span>
                }
              />
              <TooltipContent>
                Coming soon — Telegram connection wires up in a later step.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </section>
  )
}
