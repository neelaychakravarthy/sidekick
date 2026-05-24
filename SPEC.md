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
  - **Status:** ✅ deployed via `import_project`; demo URL live on Eazo.

- **Photon Spectrum** — secondary sponsor; cross-platform messaging SDK adding iMessage parity alongside Telegram.
  - **Integration depth shipped:** Full bidirectional wiring code-complete. Receive path: `/api/photon` webhook handler with HMAC-SHA256 signature verification per Spectrum spec (v0:{ts}:{rawBody}, timingSafeEqual, 5-min replay window), persists iMessages with `platform="imessage"`, emits same Inngest `message.received` event as Telegram. Send path: `lib/photon/client.ts` lazy-inits the spectrum-ts SDK on each warm serverless container, sends via `app.send(space, text(body))` using a minimal constructed Space (id + __platform + type + phone). Schema gained `platform` pgEnum + `photon_*` columns across groups/messages/group_members. Analyzer + agent-executor are platform-agnostic (route via `lib/messaging.ts`).
  - **Demo blocker:** awaiting a Photon line (phone number) to be provisioned in the Photon dashboard. Enabling the platform alone doesn't auto-provision a line — gated on a paid tier or sales contact. Until a line lands, iMessage flow is inert at runtime; code is reviewable + deployable.
  - **Build-tool constraints:** webhook handler ACKs fast (≤6 DB queries + Inngest send, all sub-second). SDK init is lazy + cached on globalThis (no module-load network). Eazo-compatible.

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

- **Frontend:** Next.js 16 (App Router) + React 19 + Tailwind v4 + shadcn/ui (`base-nova` preset / Base UI primitives, `neutral` base color, CSS variables). `next-themes` for light/dark/system. lucide-react for icons. Originally scoped as Next 14 + Tailwind v3 + shadcn `new-york`/`slate`; `create-next-app@latest` + `shadcn@latest` drifted to current versions during the bootstrap increment. Both still ship App Router + serverless Vercel builds — Eazo compatibility verified at Phase 2 smoke import (see Open questions).
- **Backend:** Next.js API routes (serverless on Vercel — same model Eazo uses underneath)
- **Database / storage:** Vercel Postgres (Neon-backed) for Phase 1; potential migration to Eazo's managed Postgres in Phase 2. Drizzle ORM + `drizzle-kit` migrations (works with any Postgres; Eazo's convention).
- **Auth:** NextAuth.js v5 / Auth.js (`next-auth@beta`) with Google OAuth provider. JWT-only sessions in MVP (no DB adapter); DB adapter to be added when the Drizzle increment lands if we want server-revocable sessions. Custom `/signin` + `/signup` routes (UX-only split; same OAuth flow under the hood until DB enables first-time detection). Middleware protects `/dashboard/:path*`. (Eazo's built-in user system flagged as potential Phase-2 migration if it integrates cleanly.)
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

- ✅ User can sign in with Google on the Eazo-deployed web app — NextAuth v5 + Google OAuth + Drizzle adapter; custom branded /signin + /signup routes (UX-split, both call signIn("google")); JWT sessions; user/account rows persist; account-delete cascades through all related data.
- ✅ Control plane dashboard renders (empty state OK initially): groups list + activity feed + memory view sections — `/dashboard` shows live DB-backed counts; click-through hierarchy `/dashboard/groups/[id]` (recent runs + memory + rules) and `/dashboard/groups/[id]/runs/[runId]` (chat-style timeline of trigger → analyzer decision → inferred memory → ack → LLM call → final response).
- ✅ "Connect a Telegram group" flow gives copyable instructions + deeplink — `/dashboard/connect` issues a short-lived single-use claim token; instructions cover both Telegram (t.me deeplink + `@SidekickBot claim <token>`) and iMessage (Photon line number + `claim <token>`).
- ✅ When user adds bot to a real group, control plane registers it within ~5s — Telegram `my_chat_member` handler inserts group row + posts SPEC.md verbatim intro message; iMessage webhook self-heals group row on first message. Both link to user via the `claim <token>` command.
- ✅ Bot posts acknowledgment within ~3s of @-mention — agent-executor's first Inngest step posts "👀 looking into …" via `lib/messaging.ts` (routes to grammy for Telegram, Spectrum SDK for iMessage); ack message id stored on `agent_runs`.
- ✅ Bot posts a useful final response (Claude Sonnet 4.6) within ~30s — analyzer (LLM decision SILENT/DIRECT_REPLY/EXTEND_RUN/NEW_ACTION) → executor (Claude agent prompt with sliding context window) → posts response, status flips to `responded`. Verified end-to-end in Telegram with multi-paragraph LLM replies.
- ✅ Control plane updates: activity feed shows the agent run with intent + reasoning; memory view shows facts — per-step `agent_run_steps` table captures every transition with kind+payload+timestamp; run detail page renders chat-style timeline. Memory inference: analyzer emits 0-3 inferred facts per call with speaker attribution ("Neelay is vegetarian", not "i am vegetarian"); explicit `@bot remember X` and `@bot rule: Y` commands work; semantic retrieval via OpenAI text-embedding-3-small replaces dump-all-memory.
- ✅ Web app is responsive: iPhone width (~390px, primary) AND desktop (1024px+, secondary) — mobile-first Tailwind throughout; tap targets ≥44px on all interactive elements (sanity-passed `/connect`, `/account`, `/groups/[id]`, `/runs/[runId]`).
- ✅ App is publicly accessible — deployed via Eazo `import_project` to `*.eazo.dev`. (Vercel Phase 1 was skipped; went straight to Eazo.)

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

**Resolved (kept here for the demo narrative):**

- ~~When will Eazo Mobile / Eazo Creator be accessible to us?~~ — RESOLVED. Eazo is live; we deployed straight to Eazo via `import_project`. Vercel Phase 1 was skipped entirely.
- ~~Vercel vs Eazo DB for Phase 2~~ — RESOLVED. Eazo's auto-injected Postgres is used in production. Local dev uses Homebrew Postgres against `localhost:5432/sidekick`.
- ~~Eazo `import_project` + Inngest first import~~ — RESOLVED. Inngest path works on Eazo with the standard env vars.
- ~~Webhook URL bootstrap~~ — RESOLVED. Telegram webhook re-pointed to the Eazo URL via setWebhook after deploy.
- ~~NextAuth callback URL~~ — RESOLVED. Eazo URL added to Google OAuth console whitelist.
- ~~Eazo `import_project` compatibility with Next 16 + Tailwind v4 + shadcn `base-nova`~~ — RESOLVED. Eazo's build accepted our stack; no downgrade needed.
- ~~Demo fallback for "where to eat" type questions~~ — RESOLVED. Claude Sonnet 4.6 as knowledge with the agent prompt produces useful answers (verified with a real "Vietnamese in South Bay" query in Telegram); no Tavily/SerpAPI needed for MVP.

**Still open:**

- **Photon line provisioning.** Photon's iMessage integration is wired code-complete (receive via webhook + send via SDK), but enabling the platform in the Photon dashboard doesn't auto-provision a phone line. Needs paid tier or sales contact. Until a line lands, iMessage flow is inert at runtime. Telegram remains the canonical demo channel.
- **Next 16 `middleware` → `proxy` rename.** Cosmetic warning on every build. Renaming `middleware.ts` → `proxy.ts` and confirming Auth.js still hooks correctly is a future housekeeping pass.
- **First-time-user detection for /signup vs /signin.** Both routes share the same Google OAuth flow today (UX split only). With users + accounts in the DB, a future increment can branch new vs returning at the post-auth callback and route new users to a `/welcome` flow. Not required for MVP.
- **Backfill embeddings + group_members for legacy rows.** Memory/message rows that predate the embeddings + speaker-attribution increments fall back gracefully (recency-only retrieval / `user-{id}` display name) — no functional break, just less polished for the older rows.

## Other hard constraints

- **Vote-driven scoring (50% of total).** Submission must be on Eazo Mobile after publish + review. Shareable URL is key for vote mobilization — plan share copy + outreach channels ahead of demo time.
- **D+7 Viral Award cutoff: June 1, 2026, 07:00 UTC.** Independent track; can be won on top of any main award. Worth planning post-hackathon viral push (WhatsApp integration, X posts, friend-group word-of-mouth).
- **Real product, real users (rule 03.A).** Per competition rules, can't be demo-only. The bot must actually work for anyone who adds `@SidekickBot` to a group during/after the demo.
- **Eazo Creator is the ONLY permitted build tool (rule 03.B).** Anything we build outside Eazo must end up imported into Eazo via their `import_project` flow before submission. No external hosting.
