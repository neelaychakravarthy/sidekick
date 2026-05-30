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

- **iMessage via BlueBubbles** — self-hosted Mac bridge; the **active** iMessage backend.
  - **Integration depth shipped:** Full bidirectional wiring. Receive path: `/api/imessage` webhook (BlueBubbles POSTs `new-message` events, authed via `?secret=` constant-time compare), self-heals the group row, upserts the sender, handles the in-route `claim <code>` command + inert-until-claimed gate, persists with `platform="imessage"`, emits the Inngest `message.received.ambient` event (iMessage has no @-mention concept → analyzer derives "autoreply" mode). Send path is a **poll-based outbox**: `lib/messaging.ts` enqueues outbound iMessages to the `outbound_messages` table (`/api/imessage/outbox` claims a batch, `/api/imessage/outbox/ack` records the result — both secret-authed), and `scripts/imessage-bridge.mjs` running on the Mac polls, dispatches via the **localhost** BlueBubbles REST API (`POST /api/v1/message/text`, AppleScript send method by default), and acks. Vercel holds **no** BlueBubbles credentials and never connects to the laptop — the bridge only makes outbound calls (idempotent via a stable per-row tempGuid; stale-claim reclaim + bounded retries). Schema carries `bluebubbles_chat_guid` / `bluebubbles_message_guid` / `bluebubbles_handle` + the `outbound_messages` queue. Analyzer + agent-executor are platform-agnostic (route via `lib/messaging.ts`).
  - **Status:** running on a dev Mac (BlueBubbles Server + the bridge script); a dedicated Mac mini is the longer-term host. The poll-based outbox means **no tunnel in any environment** — the Mac only makes outbound calls, so the same setup works against a remote Vercel Sidekick. Bot identity is an email iMessage handle (`BLUEBUBBLES_BOT_HANDLE`, surfaced in the connect-page instructions).
  - **Photon Spectrum** retained **dormant** as an alternative backend (`lib/photon/client.ts` + `/api/photon`, no longer on the active send path) — kept reviewable, not deleted.
  - **Build-tool constraints:** webhook ACKs fast (handful of DB queries + Inngest send; the heavy LLM work runs in the Inngest functions). Eazo-compatible (native fetch, no module-load network).

## Deployment

> **Vercel is the active production target.** Eazo's `import_project` deploy API is returning 502 (platform-side outage as of 2026-05-28), so the planned Eazo path is deferred. The codebase stays Eazo-compatible — no Vercel-specific lock-in — so the Eazo path can be revisited if/when their platform recovers.

### Vercel (active production target)

- **CI/CD:** native Vercel Git integration. Push to `main` → production deploy; PRs → preview deploys. No deploy tokens in CI.
- **Checks:** GitHub Actions (`.github/workflows/ci.yml`) runs typecheck + lint + build on push to `main` and on PRs. Actions does NOT deploy — Vercel's Git integration owns that.
- **Build:** `vercel.json` sets `buildCommand` to run `pnpm db:push:ci` (= `drizzle-kit push --force`) FIRST on **production** deploys (`VERCEL_ENV=production`) to sync the Neon schema, then `pnpm build`. Preview deploys skip the migration (build only) so PRs never mutate the prod DB.
  - ⚠️ `--force` auto-confirms drizzle-kit's data-loss prompt (required for non-interactive CI). A destructive schema change therefore auto-applies on the next prod deploy — review schema diffs before merging to `main`.
- **Function duration:** the Inngest endpoint (`app/api/inngest/route.ts`) exports `maxDuration = 300` (Vercel Hobby max) so the agent's extended-thinking + web_search/web_fetch steps (30–150s) don't time out.
- **Database:** Neon (neon.tech). Set `DATABASE_URL` to the **pooled** connection string (`-pooler` host) for runtime; optionally set `DIRECT_DATABASE_URL` to the **direct** string so migrations run DDL off the pgBouncer pooler.
- **Deploy process:**
  1. Push to GitHub `main` (or open a PR for a preview)
  2. Vercel auto-deploys (configured once via Vercel UI: connect repo → set env vars → deploy)
  3. Get public URL: `https://sidekick-<hash>.vercel.app`
  4. Set Telegram webhook to `https://sidekick-<hash>.vercel.app/api/telegram` via @BotFather or curl
- **Required env vars / secrets** (set in Vercel project → Settings → Environment Variables):
  - `DATABASE_URL` — Neon pooled connection string
  - `DIRECT_DATABASE_URL` — Neon direct connection string (optional; for migrations)
  - `TELEGRAM_BOT_TOKEN` — from @BotFather on Telegram
  - `ANTHROPIC_API_KEY` — Anthropic console
  - `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` — Inngest dashboard
  - `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` — Google Cloud Console (NextAuth)
  - `NEXTAUTH_SECRET` — generate locally via `openssl rand -base64 32`
  - `NEXTAUTH_URL` — set to Vercel URL (`https://sidekick-<hash>.vercel.app`)
  - `ENCRYPTION_SECRET` — generate via `openssl rand -hex 32` (BYO-key storage)

### Eazo (deferred — platform 502)

- **Status:** blocked. `import_project` deploy API returns 502 Bad Gateway (platform-side outage as of 2026-05-28, confirmed not our code). Revisit if/when the platform recovers. Code remains Eazo-compatible — no Vercel-specific lock-in introduced.
- **Process (when unblocked):**
  1. Push final code to GitHub (already there)
  2. In Eazo chat: `import_project <repo-url>`
  3. Eazo inspects code, wires env vars, runs build check
  4. **DB decision:** point Eazo at the same Neon `DATABASE_URL` (simplest) or migrate to Eazo's managed Postgres (Drizzle migrations re-run; export/import data)
  5. **Telegram webhook re-pointed** to the Eazo URL once known
  6. **NextAuth callback URL** added to Google OAuth console for Eazo URL
  7. Launch → Public → review → live on Eazo Mobile + `*.eazo.dev` URL

## Tech stack

- **Frontend:** Next.js 16 (App Router) + React 19 + Tailwind v4 + shadcn/ui (`base-nova` preset / Base UI primitives, `neutral` base color, CSS variables). `next-themes` for light/dark/system. lucide-react for icons. Originally scoped as Next 14 + Tailwind v3 + shadcn `new-york`/`slate`; `create-next-app@latest` + `shadcn@latest` drifted to current versions during the bootstrap increment. Both still ship App Router + serverless Vercel builds — Eazo compatibility verified at Phase 2 smoke import (see Open questions).
- **Backend:** Next.js API routes (serverless on Vercel — same model Eazo uses underneath)
- **Database / storage:** Vercel Postgres (Neon-backed) for Phase 1; potential migration to Eazo's managed Postgres in Phase 2. Drizzle ORM + `drizzle-kit` migrations (works with any Postgres; Eazo's convention).
- **Auth:** NextAuth.js v5 / Auth.js (`next-auth@beta`) with Google OAuth provider. JWT-only sessions in MVP (no DB adapter); DB adapter to be added when the Drizzle increment lands if we want server-revocable sessions. Custom `/signin` + `/signup` routes (UX-only split; same OAuth flow under the hood until DB enables first-time detection). Middleware protects `/dashboard/:path*`. (Eazo's built-in user system flagged as potential Phase-2 migration if it integrates cleanly.)
- **AI / LLM:** Anthropic Claude API. Claude 3.5 Sonnet for analyzer + agent runs. Claude Haiku for the cheap dedup similarity judge if cost matters. **BYO key + free-tier cap:** users can save their own Anthropic API key in `/dashboard/account` (AES-256-GCM encrypted at rest, `ENCRYPTION_SECRET` env var). When a user has a key on file, all LLM calls for their groups use that key with no usage cap. Without one, calls fall back to the team's `ANTHROPIC_API_KEY` and the user is capped at `DAILY_LLM_CALL_LIMIT` (default 50) calls/UTC-day; when exceeded the bot stops responding for that group and posts a one-per-day chat notice linking to the dashboard. A single message that flows analyzer → agent-executor counts as 2 calls against the cap.
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
- ✅ "Connect a Telegram group" flow gives copyable instructions + deeplink — `/dashboard/connect` issues a short-lived single-use claim token; instructions cover both Telegram (t.me deeplink + `@SidekickBot claim <token>`) and iMessage (message the bot's BlueBubbles handle, or add it to a group, then `claim <token>`).
- ✅ When user adds bot to a real group, control plane registers it within ~5s — Telegram `my_chat_member` handler inserts group row + posts SPEC.md verbatim intro message; iMessage webhook self-heals group row on first message. Both link to user via the `claim <token>` command.
- ✅ Bot posts acknowledgment within ~3s of @-mention — agent-executor's first Inngest step posts "👀 looking into …" via `lib/messaging.ts` (routes to grammy for Telegram, BlueBubbles REST for iMessage); ack message id stored on `agent_runs`.
- ✅ Bot posts a useful final response (Claude Sonnet 4.6) within ~30s — analyzer (LLM decision SILENT/DIRECT_REPLY/EXTEND_RUN/NEW_ACTION) → executor (Claude agent prompt with sliding context window) → posts response, status flips to `responded`. Verified end-to-end in Telegram with multi-paragraph LLM replies.
- ✅ Control plane updates: activity feed shows the agent run with intent + reasoning; memory view shows facts — per-step `agent_run_steps` table captures every transition with kind+payload+timestamp; run detail page renders chat-style timeline. Memory inference: analyzer emits 0-3 inferred facts per call with speaker attribution ("Neelay is vegetarian", not "i am vegetarian") — keyword-based `remember` command was removed in favor of fully-semantic LLM-driven extraction; explicit `@bot rule: Y` command works for group rules; semantic retrieval via Voyage AI `voyage-3-lite` embeddings (512-dim, 200M-tokens/mo free tier) replaces dump-all-memory.
- ✅ Web app is responsive: iPhone width (~390px, primary) AND desktop (1024px+, secondary) — mobile-first Tailwind throughout; tap targets ≥44px on all interactive elements (sanity-passed `/connect`, `/account`, `/groups/[id]`, `/runs/[runId]`).
- ✅ App is publicly accessible — deployed to Vercel (`https://sidekick-<hash>.vercel.app`) via native Git integration; Neon DB; GitHub Actions runs checks; Inngest endpoint `maxDuration=300`. Eazo deploy deferred (platform 502 as of 2026-05-28); code stays Eazo-compatible for later import.

## Required behaviors

- **Silent unless @-mentioned (default mode).** No proactive intervention in the default mode. Triggered only by explicit `@SidekickBot` mentions. **Auto-reply mode (opt-in, per-group):** toggle via the dashboard or `@SidekickBot autoreply on|off` in chat. When enabled, the analyzer evaluates every message in the group; it can still choose `SILENT` for ambient chatter and only responds when it judges it can help. iMessage groups are always auto-reply (no native @-mention concept in iMessage).
- **Public introduction message on group add.** When `@SidekickBot` joins a group, post: *"Hi! I'm Sidekick. I help groups plan and coordinate — @ me to ask. Your messages stay in this group; see [link] for what I store. To opt out, reply STOP."*
- **Hybrid memory model.**
  - *Inferred memory:* analyzer extracts 0-3 facts per LLM call from chat context (preferences, decisions, recurring patterns, person-attributed facts) → writes to `group_memory` with `source="inferred"`. Semantically distinguishes memory-statements ("I'm vegan", "remember I live in SF") from memory-queries ("what do you remember about me?") — the former extracts, the latter answers using existing memory.
  - *Explicit rules:* `@SidekickBot rule: Y` → stores as `group_rules` (system-prompt additions for that group). Different from memory (configuration, not facts).
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
| `group_memory` | Per-group key-value facts (key, value JSONB, source = "inferred") |
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

- **iMessage now runs on BlueBubbles (self-hosted Mac bridge).** Receive via `/api/imessage` webhook; send via a **poll-based outbox** (`outbound_messages` + `/api/imessage/outbox` + `/api/imessage/outbox/ack`, drained by `scripts/imessage-bridge.mjs` on the Mac over localhost BlueBubbles). Vercel holds no BlueBubbles credentials and never connects to the laptop. Bot identity is a dedicated email iMessage handle. Running on a dev Mac locally for end-to-end testing; a dedicated Mac mini is the intended longer-term host (so the bot's identity is isolated from anyone's personal Mac). Photon's earlier integration is retained **dormant** as an alternative backend (no longer on the active send path), not deleted. **Telegram remains the canonical demo channel for MVP**; iMessage is the second live channel. Twilio SMS / WhatsApp Business stay out of scope (group MMS carrier-flaky; WhatsApp opt-in friction).
- **Next 16 `middleware` → `proxy` rename.** Cosmetic warning on every build. Renaming `middleware.ts` → `proxy.ts` and confirming Auth.js still hooks correctly is a future housekeeping pass.
- **First-time-user detection for /signup vs /signin.** Both routes share the same Google OAuth flow today (UX split only). With users + accounts in the DB, a future increment can branch new vs returning at the post-auth callback and route new users to a `/welcome` flow. Not required for MVP.
- **Backfill embeddings + group_members for legacy rows.** Memory/message rows that predate the embeddings + speaker-attribution increments fall back gracefully (recency-only retrieval / `user-{id}` display name) — no functional break, just less polished for the older rows.

## Other hard constraints

- **Vote-driven scoring (50% of total).** Submission must be on Eazo Mobile after publish + review. Shareable URL is key for vote mobilization — plan share copy + outreach channels ahead of demo time.
- **D+7 Viral Award cutoff: June 1, 2026, 07:00 UTC.** Independent track; can be won on top of any main award. Worth planning post-hackathon viral push (WhatsApp integration, X posts, friend-group word-of-mouth).
- **Real product, real users (rule 03.A).** Per competition rules, can't be demo-only. The bot must actually work for anyone who adds `@SidekickBot` to a group during/after the demo.
- **Eazo Creator is the ONLY permitted build tool (rule 03.B).** Anything we build outside Eazo must end up imported into Eazo via their `import_project` flow before submission. No external hosting.
