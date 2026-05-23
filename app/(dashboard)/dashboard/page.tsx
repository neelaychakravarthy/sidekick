import { Activity, Brain, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default function DashboardPage() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-6">
      <Card className="p-6">
        <CardHeader className="gap-3 px-0">
          <div className="flex size-10 items-center justify-center rounded-md bg-muted text-foreground">
            <Users className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-lg">Your groups</CardTitle>
          <CardDescription className="text-sm leading-relaxed">
            No groups yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Button disabled size="lg" className="h-12 px-6 text-base">
            Connect a Telegram group
          </Button>
        </CardContent>
      </Card>
      <Card className="p-6">
        <CardHeader className="gap-3 px-0">
          <div className="flex size-10 items-center justify-center rounded-md bg-muted text-foreground">
            <Activity className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-lg">Recent activity</CardTitle>
          <CardDescription className="text-sm leading-relaxed">
            Nothing yet. Once you @SidekickBot in a group, runs appear here.
          </CardDescription>
        </CardHeader>
      </Card>
      <Card className="p-6">
        <CardHeader className="gap-3 px-0">
          <div className="flex size-10 items-center justify-center rounded-md bg-muted text-foreground">
            <Brain className="size-5" aria-hidden />
          </div>
          <CardTitle className="text-lg">Memory</CardTitle>
          <CardDescription className="text-sm leading-relaxed">
            Empty. Sidekick will remember per-group facts as it learns.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
