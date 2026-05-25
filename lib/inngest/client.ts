import { Inngest } from "inngest";

// Event name reference (this Inngest version doesn't expose EventSchemas for
// compile-time type registration; the rename from the single `message.received`
// event to mention/ambient streams is enforced by call-site greps rather than
// types):
//
//   "message.received.mention" — webhook routed an @-mention. No debounce.
//     data: { groupId, messageId, telegramMessageId?, photonMessageId?, text? }
//   "message.received.ambient" — webhook routed ambient chat. Per-group debounce.
//     data: { groupId, messageId, telegramMessageId?, photonMessageId?, text? }
//   "agent.run-requested" — analyzer hands off to the executor.
//     data: { groupId, runId, triggerMessageIds: string[] }
export const inngest = new Inngest({
  id: "sidekick",
});
