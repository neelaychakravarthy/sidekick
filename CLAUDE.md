# CLAUDE.md — Sidekick

## Project context

Hackathon project for the **Eazo Creator Hackathon** (May 23–24, 2026, SF). See [`SPEC.md`](SPEC.md) for what we're building, sponsors, deployment, and tech stack. **Always read `SPEC.md` first** when starting a session — its "Required sponsors / integrations" (Eazo Creator) and "Deployment" sections are submission-load-bearing.

## Build / run / test / deploy

> Filled in by `/kickoff`. Update as the project evolves.

- **Install:** `pnpm install` (or `npm install`)
- **Run dev:** Three terminals:
  - `pnpm dev` — Next.js dev server (port 3000)
  - `pnpm inngest:dev` — Inngest CLI dev server (port 8288). Or: `npx inngest-cli@latest dev`
  - `ngrok http 3000` — expose webhook for Telegram. Update bot webhook to `https://<ngrok-url>/api/telegram`
- **Test:** none in MVP scope; add as needed
- **Lint / typecheck:** `pnpm typecheck && pnpm lint`
- **Build (deployable-state check):** `pnpm build` — must succeed before pushing
- **Migrate DB:** `pnpm db:push` against local Postgres OR remote Neon once connected. CI/prod-deploy uses `pnpm db:push:ci` (`drizzle-kit push --force`, non-interactive). drizzle-kit prefers `DIRECT_DATABASE_URL` (Neon unpooled) for DDL, falling back to `DATABASE_URL`.
- **Deploy (Vercel — primary, active now):**
  1. `git push` to GitHub `main` (or open a PR for a preview deploy)
  2. Vercel auto-deploys via native Git integration (set up once: connect GitHub repo to Vercel project, add env vars incl. Neon `DATABASE_URL`). Push to `main` → production; PRs → preview.
  3. GitHub Actions (`.github/workflows/ci.yml`) runs typecheck + lint + build on push/PR. Actions does NOT deploy — Vercel's Git integration does.
  4. `vercel.json` runs `db:push:ci` before build on **production** deploys only (`VERCEL_ENV=production`); previews skip the migration. ⚠️ `--force` auto-applies data-loss schema changes on prod deploy — review schema diffs before merging to `main`.
  5. Live at `https://sidekick-<hash>.vercel.app`. Update Telegram bot webhook to the Vercel URL after first deploy.
- **Deploy (Eazo — deferred, platform 502):**
  - Blocked: `import_project` deploy API returns 502 (platform-side outage as of 2026-05-28, not our code). Code stays Eazo-compatible. When unblocked:
  1. Push final code to GitHub (already there)
  2. In Eazo chat: `import_project <repo-url>`
  3. Eazo wires env vars + build check
  4. Launch → Public → review → live on Eazo Mobile + `*.eazo.dev` URL

## Git policy

**Never alter git state without explicit approval.** Prohibited without explicit request: `git stash`, `git reset`, `git checkout`, `git restore`, `git clean`, `git commit`, `git rebase`, `git cherry-pick`, force-push, branch rename / delete, amend. Read-only commands (`git log`, `git diff`, `git blame`, `git show`, `git status`) are always fine.

**Documented exceptions** (skills that explicitly perform git writes after their plan-approval gate):
- `/kickoff` Phase 4 — initial `git init` + first commit (runs during `--start`, not `--spec-only`)
- `/ship-it` Phase 6 — optional commit-after-verify with explicit approval
- `/debug` Phase 8 — optional commit-after-verify with explicit approval

**First push on a new branch:** `git push -u origin <branch>` to set tracking. After that, plain `git push`.

## Conventions

- **No drive-by refactors.** Increment scope is whatever `/ship-it` (or `/debug`) plan said. Don't expand silently. The `implementor` agent enforces this — if you want to "clean this up while I'm here," report it as a follow-up instead.
- **Vercel is the active deploy target; Eazo is deferred (platform 502).** Vercel runs production now via native Git integration (Neon DB). Eazo's `import_project` is blocked on a platform outage — keep the code Eazo-compatible so it can be imported later. Both targets share the same code; don't introduce anything that breaks one. Specifically: anything that breaks Eazo's import path is OUT — custom Dockerfiles, non-Vercel-compatible deps, long-lived Node daemons. Use Inngest for any async work.
- **Drizzle ORM is required.** Eazo's Postgres provisioning expects drizzle-kit migrations at build time. Don't introduce Prisma / TypeORM / raw SQL migrations.
- **No long-running Node processes.** Webhooks must ACK fast and dispatch async work via Inngest events. No `setInterval`/`setTimeout` polling loops anywhere. Vercel serverless function timeouts apply (Hobby ceiling now 300s; the Inngest endpoint sets `maxDuration = 300` for the agent's long LLM steps).
- **Mobile-first UI.** Every new component must be designed at iPhone width (~390px) first; desktop is a secondary breakpoint, not the primary canvas. Tailwind default classes target mobile; use `sm:` / `md:` / `lg:` to enhance for larger screens. Tap targets ≥ 44px.
- **Always post acknowledgment messages.** Per SPEC.md required behaviors: before *any* heavy agent work, post an "👀 looking into X" message to chat first. Users and group members rely on this signal — without it they re-ask and we kick off duplicate runs.
- **Always check dedup before creating a new `agent_runs` row.** Active runs for the group must be inspected first. Append to existing run if intent overlaps.
- **Hackathon time budget is real.** Prefer simplest working over cleanest. Tech debt OK if documented in `SPEC.md` "Out of scope" or "Open questions". Ship the demo, document the debt.
- **Every increment leaves the project deployable.** Run `pnpm build` after meaningful changes. The implementor checks this automatically; you should too when editing manually.
- **No new dependencies without approval.** If a task seems to need a new package, surface it before adding.

## Available skills

| Skill            | When                                                       |
|------------------|------------------------------------------------------------|
| `/ship-it`       | Plan + implement the next increment toward the MVP         |
| `/debug`         | RCA-first bug-fix loop when the root cause isn't known     |
| `/pr-feedback`   | Triage + address PR review comments (if using PRs)         |
| `/skill-create`  | Create a new project-local skill                           |
| `/agent-create`  | Create a new project-local subagent                        |
| `/onboarding`    | Re-read the harness walkthrough                            |
| `/kickoff --start` | Run at hackathon start to do `git init` + first commit   |

## Agent stack

| Agent              | Model  | Role                                                                          |
|--------------------|--------|-------------------------------------------------------------------------------|
| `context-gatherer` | sonnet | Phase-1 brief: SPEC.md + CLAUDE.md + recent activity + focus findings         |
| `investigator`     | opus   | Answer one narrow question with grounded findings + proposed decision         |
| `implementor`      | opus   | Scoped file edits per an approved plan. Writes code; no git mutations         |

**Discovery caveat:** custom agents load at Claude Code **session start**. Adding or editing a file under `.claude/agents/` does NOT hot-reload — restart the session.

(Skills hot-load. Edit a SKILL.md and the next `/<name>` invocation picks it up.)

## What NOT to do

- ❌ Edit code in chat without invoking a skill. Even tiny changes go through `implementor` for the audit trail + deployable-state check.
- ❌ Let `SPEC.md` drift from reality. Update it when scope changes.
- ❌ Push without explicit confirmation.
- ❌ Skip the deployable-state check (`pnpm build`). Every increment must leave the project demoable.
- ❌ Forget sponsor requirements. SPEC.md has them — the implementor verifies per increment.
- ❌ Add long-running Node daemons / BullMQ / external Redis. Both Vercel and Eazo deploy via serverless — only Inngest is the supported async path.
- ❌ Bypass the acknowledgment-message pattern. Always post the "👀" message before heavy work.
- ❌ Design components desktop-first. Always sketch at iPhone width first, then enhance for desktop. Reversing this order produces UIs that feel cramped on mobile.
