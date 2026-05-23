import { Brain, MessageCircle, VolumeOff } from "lucide-react"

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const features = [
  {
    icon: MessageCircle,
    title: "Lives in your group",
    body: "Add @SidekickBot once. It's there in the background, ready when you need it.",
  },
  {
    icon: VolumeOff,
    title: "Silent until you ask",
    body: "No notifications, no spam. Only chimes in when you @-mention it directly.",
  },
  {
    icon: Brain,
    title: "Learns the group",
    body: "Remembers preferences, decisions, and recurring patterns — gets more useful the longer it's around.",
  },
]

export function LandingFeatures() {
  return (
    <section className="mx-auto w-full max-w-5xl px-6 pb-20 md:pb-28">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-6">
        {features.map(({ icon: Icon, title, body }) => (
          <Card key={title} className="p-6">
            <CardHeader className="gap-3 px-0">
              <div className="flex size-10 items-center justify-center rounded-md bg-muted text-foreground">
                <Icon className="size-5" aria-hidden />
              </div>
              <CardTitle className="text-lg">{title}</CardTitle>
              <CardDescription className="text-sm leading-relaxed">
                {body}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </section>
  )
}
