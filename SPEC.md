# Sidekick — Hackathon SPEC

> Canonical project context. `/ship-it`, `/debug`, `/pr-feedback`, and the agents all read from here. Edit this file when scope changes — never let the code drift from the spec.

## Project summary

Sidekick is an AI agent that lives in your group chats. Add `@SidekickBot` to a Telegram group; when group members @-mention it, Sidekick chimes in with useful async actions — polls, restaurant suggestions, scheduling help, summaries — built on shared per-group context that it learns over time. Silent unless summoned; always announces itself when starting work (so the group knows not to re-ask); dedups against in-flight work; reads chat with a sliding context window like a person would.

MVP demo flow: user registers in the Sidekick web app (control plane), gets instructions to add `@SidekickBot` to a Telegram group, runs a live group-chat demo where Sidekick responds to @-mentions, then returns to the control plane to see the activity feed + memory populated by the live interaction.

## Event context

- **Hackathon:** Eazo Creator Hackathon
- **Time budget:** ~24h (May 23 → evening of May 24, 2026 SF time; Global Awards Ceremony evening of May 24)
- **Demo / submission requirements:** Published on Eazo Mobile + public `*.eazo.dev` URL accessible via shareable link. Submission via Eazo Mobile app only. Public votes count for 50% of total score. Target: **Global Main Award**.

## Required sponsors / integrations

- **Eazo Creator** — submission-load-bearing (only permitted build tool per competition rule 03.B).
  - **Integration depth required:** Final product MUST be built and published via Eazo Creator. Our approach: build core Next.js project locally with Claude Code → push to GitHub → share repo URL in Eazo chat → use Eazo's `import_project` command → Eazo runs build check + ships through standard review/publish flow.
  - **Deployment surface:** Published to Eazo Mobile + public `*.eazo.dev` URL.
  - **Build-tool constraints to honor:** No long-lived Node daemons (Vercel serverless under the hood). All async work via Inngest. Drizzle ORM is Eazo's convention — migrations run at build time via `drizzle-kit`. Use the Eazo Next.js template patterns.

## Deployment

> **Two-phase plan.** Eazo Mobile / Eazo Creator are not yet live as of May 23. We deploy on Vercel during build & test, then migrate to Eazo for submission once that platform is up.

### Phase 1 — Vercel (active during build & test)

- **Target:** Vercel (auto-deploy from GitHub)
- **Deploy process:**
  1. Push to GitHub
  2. Vercel auto-deploys on push (configured once via Vercel UI: connect repo → set env vars → deploy)
  3. Get public URL: `https://sidekick-<hash>.vercel.app`
  4. Set Telegram webhook to `https://sidekick-<hash>.vercel.app/api/telegram` via @BotFather or curl
- **Database:** Vercel Postgres (Neon-backed). Provisioned via Vercel UI → "Storage" → Postgres → "Create". `DATABASE_URL` + `POSTGRES_URL` auto-injected.
- **Required env vars / secrets** (set in Vercel project → Settings → Environment Variables):
  - `TELEGRAM_BOT_TOKEN` — from @BotFather on Telegram
  - `ANTHROPIC_API_KEY` — Anthropic console
  - `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` — Inngest dashboard
  - `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` — Google Cloud Console (NextAuth)
  - `NEXTAUTH_SECRET` — generate locally via `openssl rand -base64 32`
  - `NEXTAUTH_URL` — set to Vercel URL (`https://sidekick-<hash>.vercel.app`)
  - `DATABASE_URL` — auto-injected by Vercel Postgres integration

### Phase 2 — Eazo (for submission)

- **Trigger:** Once Eazo Mobile is live and Eazo Creator is accessible.
- **Process:**
  1. Push final code to GitHub (already there)
  2. In Eazo chat: `import_project <repo-url>`
  3. Eazo inspects code, wires env vars, runs build check
  4. **DB migration decision:** Eazo's auto-injected Postgres vs keep Vercel Postgres
     - Path A: migrate schema + data to Eazo's DB (Drizzle migrations re-run; export/import data)
     - Path B: keep Vercel Postgres (Eazo deploy points at same DATABASE_URL — simpler if Eazo allows)
  5. **Telegram webhook re-pointed** to the Eazo URL once known
  6. **NextAuth callback URL** added to Google OAuth console for Eazo URL
  7. Launch → Public → review → live on Eazo Mobile + `*.eazo.dev` URL

## Tech stack

- **Frontend:** Next.js 14 App Router + React + Tailwind + shadcn/ui
- **Backend:** Next.js API routes (serverless on Vercel — same model Eazo uses underneath)
- **Database / storage:** Vercel Postgres (Neon-backed) for Phase 1; potential migration to Eazo's managed Postgres in Phase 2. Drizzle ORM + `drizzle-kit` migrations (works with any Postgres; Eazo's convention).
- **Auth:** NextAuth.js with Google OAuth provider. (Eazo's built-in user system flagged as potential Phase-2 migration if it integrates cleanly.)
- **AI / LLM:** Anthropic Claude API. Claude 3.5 Sonnet for analyzer + agent runs. Claude Haiku for the cheap dedup similarity judge if cost matters.
- **Async / background jobs:** Inngest (Eazo-confirmed first-class Next.js support; works natively on Vercel too). Provides event-driven queues, retries, observability — replaces any long-lived Node worker pattern.
- **Telegram bot:** `grammy` SDK (or raw `fetch` if minimal) — webhook (NOT long-polling) at `/api/telegram`.
- **Local dev:** Next.js dev server + Inngest CLI dev server (`npx inngest-cli@latest dev`) + `ngrok http 3000` for Telegram webhook tunneling. Bot webhook re-pointed to ngrok URL during dev.

## UI design constraints

- **Mobile-first, iPhone-optimized.** Final submission lives on Eazo Mobile; primary target is iPhone-sized screens (~390px wide). Design at that width first.
- **Desktop must remain usable.** All dev testing happens on Vercel via desktop browser until Eazo Mobile is live. Components must remain functional and presentable at 1024px+, not just "work but ugly."
- **Tailwind is mobile-first by default.** Use `sm:` / `md:` / `lg:` breakpoints to progressively enhance for larger screens. Default classes target mobile.
- **shadcn/ui components.** Use shadcn/ui (responsive by default) over custom UI for hackathon speed.
- **Viewport meta tag:** Ensure `<meta name="viewport" content="width=device-width, initial-scale=1">` is set in the root layout.
- **Touch targets:** Minimum 44px tap-target size on interactive elements (Apple HIG standard).

## MVP acceptance criteria

> The *minimum* shape the demo needs by submission. Each `/ship-it` increment moves one of these closer to ✅.

- [ ] User can sign in with Google on the Eazo-deployed web app
- [ ] Control plane dashboard renders (empty state OK initially): groups list + activity feed + memory view sections
- [ ] "Connect a Telegram group" flow gives copyable instructions + deeplink to `@SidekickBot`
- [ ] When user adds bot to a real Telegram group, control plane registers the group within ~5s (bot intro message posted to chat)
- [ ] When user @-mentions `@SidekickBot` in the group with a coordination/planning question, bot posts acknowledgment message ("👀 looking into X…") within ~3s
- [ ] Bot posts a useful final response (LLM-generated answer) to the chat within ~30s
- [ ] Control plane updates: activity feed shows the agent run with intent + reasoning; memory view shows any facts the agent stored
- [ ] Web app is responsive: looks intentional at iPhone width (~390px, primary) AND remains usable at desktop width (1024px+, secondary)
- [ ] App is publicly accessible — Phase 1: `https://sidekick-<hash>.vercel.app`; Phase 2: `*.eazo.dev` URL + submitted via Eazo Mobile when platform is live

## Required behaviors

- **Silent unless @-mentioned.** No proactive intervention in MVP. Triggered only by explicit `@SidekickBot` mentions. Proactive planning-detection is V2 (Open question / Out of scope).
- **Public introduction message on group add.** When `@SidekickBot` joins a group, post: *"Hi! I'm Sidekick. I help groups plan and coordinate — @ me to ask. Your messages stay in this group; see [link] for what I store. To opt out, reply STOP."*
- **Hybrid memory model.**
  - *Passive:* analyzer extracts facts from chat context (preferences, decisions, recurring patterns) → writes to `group_memory` with `source="inferred"`.
  - *Explicit:* `@SidekickBot remember X` or `@SidekickBot rule: Y` → stores as `group_rules` (system-prompt additions for that group).
  - Control plane shows both, read-only in MVP. Edit/forget UI is V2.
- **Async processing pipeline.**
  - Telegram webhook hits `/api/telegram` → writes message to `messages` table → emits Inngest event `message.received` → returns 200 fast (Telegram retries if slow).
  - Inngest `analyzer` function: pulls sliding context window (last 20 msgs or last 30 min), fetches active `agent_runs` for group, calls Claude with full context. Returns one of: `SILENT` | `DIRECT_REPLY` | `EXTEND_RUN <id>` | `NEW_ACTION`.
  - On `NEW_ACTION`: dedup judge runs first (keyword overlap MVP; semantic similarity V2). If similar to active run, convert to `EXTEND_RUN`. Else create `agent_runs` row + emit `agent.run-requested`.
  - Inngest `agent-executor` function: posts ack message → updates run status to `acting` → runs tool calls (LLM + optional web/maps later) → posts final response → marks `responded`.
- **Mandatory acknowledgment.** Before *any* heavy agent work (LLM tool-calling, web lookup, etc.), Sidekick MUST post an acknowledgment message to the chat. Eliminates "is the bot working?" duplicate asks.
- **Dedup against active runs.** Before creating a new `agent_runs` row, check active runs for that group. Append to existing trigger list if intent overlaps. Prevents duplicate work and parallel-response spam.
- **Sliding context window.** Analyzer always receives: last 20 messages (capped at last 30 min) + active `agent_runs` summaries + per-group memory + per-group rules. Mimics a human catching up on a chat.

## Data model

| Table | Purpose |
|---|---|
| `users` | NextAuth users (id, email, google_id) |
| `groups` | Connected Telegram groups (telegram_chat_id, registered_by_user_id, name, settings JSON) |
| `group_members` | Lightweight tracking of telegram users present in connected groups (no full user model for non-registered) |
| `messages` | All messages observed in connected groups (telegram_message_id, sender, text, ts, raw JSON) |
| `agent_runs` | A single agentic work unit. Columns: `trigger_message_ids[]`, `status` (queued/analyzing/acting/responded/failed), `intent_summary`, `intent_keywords[]`, `ack_message_id`, `response_message_id`, `reasoning`, timestamps, `error_text` |
| `group_memory` | Per-group key-value facts (key, value JSONB, source = "inferred" or "user-stated") |
| `group_rules` | Per-group system-prompt additions from `@SidekickBot rule:` commands (rule_text, created_by_telegram_user_id) |

## Out of scope (Known Issues / Future Scope)

Explicitly NOT in MVP. Listed here so the implementor doesn't accidentally scope-creep into them, and so `/ship-it` re-surfaces them on later rounds:

- **Smart triggers / proactive intervention** — MVP responds only to @-mentions. Detecting "looks like the group is planning" patterns is V2.
- **Semantic similarity dedup** — MVP uses keyword overlap. LLM-judge semantic similarity is fast follow.
- **Topic-shift-aware sliding window** — MVP uses fixed last-20-messages / 30-min window.
- **WhatsApp Business + SMS channels** — Telegram only for MVP. WhatsApp planned for D+7 Viral Award push.
- **Per-group settings UI** — defaults only in MVP. Manual DB edits available during demo if needed.
- **Per-user opt-out flow** — relies on bot intro message + group admin can remove bot. Full opt-out UI deferred.
- **Rich memory inspector with edit/forget UI** — MVP shows activity + memory read-only.
- **Custom persona / system prompt per group via UI** — `group_rules` settable via `@SidekickBot rule:` chat commands but not yet through control plane UI.
- **Live web search / Maps / Calendar tool integrations** — MVP uses LLM-as-knowledge. For restaurant/scheduling demo questions may hardcode plausible-sounding fallback data.
- **Multi-user account model with shared groups** — MVP is single-tenant. One registered user per group; group invite/share is V2.
- **Eazo's built-in user system migration** — MVP uses NextAuth + Google; evaluate migrating to Eazo's user system post-import if integration is clean.

## Open questions

> `/ship-it` re-surfaces these before round 2 of relevant increments.

- **When will Eazo Mobile / Eazo Creator be accessible to us?** Drives the Phase 1 → Phase 2 migration plan. Until then, Vercel is the demo URL.
- **Vercel vs Eazo DB for Phase 2:** Migrate data to Eazo's auto-injected Postgres, or keep Vercel Postgres connection string? Decide when Phase 2 starts.
- **Eazo `import_project` + Inngest first import:** Eazo confirmed Inngest works, but the first import may surface env-var quirks. Do a smoke import early in Phase 2 rather than right before submission.
- **Webhook URL bootstrap:** Telegram webhook needs the deployed URL to register. Order: deploy to Vercel → get URL → set webhook → demo. Re-point to Eazo URL in Phase 2.
- **NextAuth callback URL:** Google OAuth console needs all callback URLs whitelisted (`http://localhost:3000`, the Vercel URL, and eventually the Eazo URL). Add as you go.
- **Demo fallback for "where to eat" type questions:** If web search tool not wired by demo time, what's the realism strategy? Options: (a) hardcoded plausible data, (b) LLM-as-knowledge with light prompting, (c) wire a quick Tavily/SerpAPI call. Decide by mid-hackathon.

## Other hard constraints

- **Vote-driven scoring (50% of total).** Submission must be on Eazo Mobile after publish + review. Shareable URL is key for vote mobilization — plan share copy + outreach channels ahead of demo time.
- **D+7 Viral Award cutoff: June 1, 2026, 07:00 UTC.** Independent track; can be won on top of any main award. Worth planning post-hackathon viral push (WhatsApp integration, X posts, friend-group word-of-mouth).
- **Real product, real users (rule 03.A).** Per competition rules, can't be demo-only. The bot must actually work for anyone who adds `@SidekickBot` to a group during/after the demo.
- **Eazo Creator is the ONLY permitted build tool (rule 03.B).** Anything we build outside Eazo must end up imported into Eazo via their `import_project` flow before submission. No external hosting.
