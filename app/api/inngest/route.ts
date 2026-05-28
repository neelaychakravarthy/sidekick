import { serve } from "inngest/next";

import { inngest } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest/functions";

// Inngest invokes this endpoint once per function step. The agent-executor's
// LLM step (extended thinking + web_search + web_fetch) can take 30-150s, so
// raise the serverless function ceiling. 300s is the Vercel Hobby maximum.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
