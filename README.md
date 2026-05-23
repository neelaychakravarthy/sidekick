# Sidekick

AI agent that lives in your group chats. Add `@SidekickBot` to a Telegram group and @-mention it for planning help, polls, restaurant suggestions, and coordination assistance.

> **Hackathon project** — Eazo Creator Hackathon, May 23–24, 2026.
> See [`SPEC.md`](SPEC.md) for project context, sponsors, MVP criteria, and tech stack.
> See [`CLAUDE.md`](CLAUDE.md) for build / run / test / deploy commands.

## Quick start (local)

Three terminals:

```bash
pnpm install
pnpm dev                              # Next.js dev server (port 3000)
pnpm inngest:dev                      # Inngest dev server (port 8288)
ngrok http 3000                       # expose webhook for Telegram
```

Then update the Telegram bot webhook to `https://<your-ngrok-url>/api/telegram` via @BotFather.

## Deploy

**Phase 1 (now):** Push to GitHub → Vercel auto-deploys → live at `https://sidekick-<hash>.vercel.app`. Set Telegram webhook to that URL.

**Phase 2 (once Eazo Mobile launches):** In Eazo chat: `import_project <repo-url>`. See [`SPEC.md`](SPEC.md#deployment).
