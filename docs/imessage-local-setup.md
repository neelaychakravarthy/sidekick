# iMessage Local Setup & E2E Test (BlueBubbles)

End-to-end guide to run Sidekick's iMessage integration locally: a dedicated
Apple ID in a separate macOS user, BlueBubbles Server as the bridge, and
Sidekick on `localhost`. No tunnel needed — everything is loopback on one Mac.

## Architecture (local)

```
Your iPhone / personal Apple ID
        │  (iMessage, via Apple's servers)
        ▼
Sidekick Apple ID  ──signed into──▶  Messages.app  (in the "Sidekick" macOS user)
                                          │  writes ~/Library/Messages/chat.db
                                          ▼
                                   BlueBubbles Server  (localhost:1234)
                                          │
                  ┌── webhook POST ───────┤
                  ▼                        │
   http://localhost:3000/api/imessage      │  ◀── REST send (POST /api/v1/message/text)
                  │ (Next dev)             │       lib/bluebubbles/client.ts
                  ▼                        │
   inngest.send("message.received.ambient")│
                  ▼                        │
   Inngest dev server (localhost:8288)     │
                  ▼                        │
   analyzer-ambient → agent-executor ──────┘  (reply routed back through BlueBubbles)
```

Loopback (`127.0.0.1`) is machine-wide across macOS user sessions, so
BlueBubbles (Sidekick user) ↔ Next dev (your user) talk over `localhost`
without a tunnel.

---

## Part 1 — Mac: dedicated Sidekick user + Apple ID

1. **Create a dedicated Apple ID** (email-handle, free): https://account.apple.com → *Create Your Apple ID*. Use a fresh email. Apple will ask for a phone number — that's **2FA verification only**; it does **not** become the bot's iMessage handle (the **email** will be). You can use your own number for the code.
2. **Create a "Sidekick" macOS user:** System Settings → Users & Groups → *Add Account* → **Admin** (Admin makes granting Full Disk Access easier), set a password.
3. **Enable Fast User Switching:** System Settings → Control Center → *Fast User Switching* → "Show in Menu Bar". This lets the Sidekick user run in the background while you work in your own account.
4. **Switch into the Sidekick user** (menu-bar switcher). Your personal session keeps running in the background.
5. In the Sidekick session: **Messages.app → sign in with the Sidekick Apple ID → turn on iMessage.** Messages → Settings → iMessage → confirm "You can be reached at" shows the **email**.
6. **Sanity check:** from your *personal* iMessage, send a message to the Sidekick email → confirm it arrives in the Sidekick user's Messages (blue bubble). Do this BEFORE involving BlueBubbles — it isolates Apple-side issues.

---

## Part 2 — Mac: BlueBubbles Server (in the Sidekick session)

1. **Download BlueBubbles Server** (macOS app): https://bluebubbles.app/install (or GitHub releases v1.9.9+). Move to Applications, open it.
2. **Grant permissions** (all in the Sidekick session — these are per-user):
   - **Full Disk Access** — System Settings → Privacy & Security → Full Disk Access → enable BlueBubbles (reads `chat.db`).
   - **Accessibility** — Privacy & Security → Accessibility → enable BlueBubbles (AppleScript send).
   - **Automation** — when BlueBubbles first sends, allow it to control "Messages".
3. **In the BlueBubbles UI:**
   - **Password:** Settings → Connection → set/note the server password → this is `BLUEBUBBLES_PASSWORD`.
   - **Server URL/port:** default `http://localhost:1234` → this is `BLUEBUBBLES_SERVER_URL`. (Ignore the Cloudflare/ngrok proxy for local — we use localhost. The proxy is only needed in prod, see Appendix.)
   - **Private API:** leave **OFF** (we use AppleScript). You can switch to Private API later for richer group features (needs a SIP tweak + helper bundle).
   - **Webhooks:** Settings → API & Webhooks → *Add Webhook* →
     URL: `http://localhost:3000/api/imessage?secret=<BLUEBUBBLES_WEBHOOK_SECRET>`
     Event: enable **"New Messages"** (others are fine; we filter to new-message). Save.
4. **Disable sleep** so the background session keeps polling: System Settings → Lock Screen → never sleep; or run `caffeinate -s` in a Terminal in the Sidekick session.

> ⚠️ Keep the Sidekick user **switched** (logged in), never **logged out** — a logged-out user's processes stop. Reboots require re-login.

---

## Part 3 — Sidekick: env vars + schema

1. **Generate the webhook secret:** `openssl rand -hex 32` (use the SAME value in the BlueBubbles webhook URL above and the env var below).
2. **Add to `.env.local`:**
   ```
   BLUEBUBBLES_SERVER_URL=http://localhost:1234
   BLUEBUBBLES_PASSWORD=<the BlueBubbles server password>
   BLUEBUBBLES_WEBHOOK_SECRET=<the openssl value — must match the ?secret= in the webhook URL>
   BLUEBUBBLES_SEND_METHOD=apple-script
   BLUEBUBBLES_BOT_HANDLE=<the Sidekick Apple ID email>   # shown on /dashboard/connect
   ```
3. **Schema:** already applied via `pnpm db:push` (adds `bluebubbles_chat_guid`, `bluebubbles_message_guid`, `bluebubbles_handle`). On a fresh clone, run `pnpm db:push`.
4. **Inngest local routing:** make sure `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` are **NOT set** in `.env.local`, so events route to the local Inngest dev server (not prod Cloud).

---

## Part 4 — Startup

In your **main** user session (where the repo lives), three processes:

| Terminal | Command | What |
|---|---|---|
| 1 | `pnpm dev` | Next.js on `localhost:3000` |
| 2 | `pnpm inngest:dev` | Inngest dev server on `localhost:8288` (auto-discovers `localhost:3000/api/inngest`) |
| 3 | (already running) | BlueBubbles Server in the Sidekick user session |

- **No ngrok needed** for iMessage (all localhost). (Telegram would still need ngrok — separate.)
- **Verify Inngest registered:** open `localhost:8288` → Apps → "sidekick" with `analyzer-mention`, `analyzer-ambient`, `agent-executor`.

---

## Part 5 — E2E test walkthrough

Message the bot **from your personal iMessage** (iPhone, or your main macOS user's Messages signed into *your* Apple ID) → to the Sidekick email handle.

1. **Start the chat.** New iMessage to the Sidekick email. For a **group** test: create a group with you + the Sidekick email (+ optionally a friend).
2. **Send any message** (e.g. `hey`).
   - ✅ Expect within ~2–5s: Sidekick replies with the **claim prompt** ("I'm not active in this chat yet… go to …/dashboard/connect … send `claim <code>`").
   - Under the hood: chat.db poll → webhook → `/api/imessage` → group self-healed (unclaimed) → claim prompt. Next logs show `POST /api/imessage 200`.
3. **Generate a claim code.** Open `http://localhost:3000/dashboard/connect` (signed into your Sidekick dashboard account) → copy the code. The iMessage card shows instructions referencing `BLUEBUBBLES_BOT_HANDLE`.
4. **Claim.** In the iMessage chat, send `claim <code>`.
   - ✅ Expect: "✅ Connected to <you>'s dashboard. I'm now active in this chat."
5. **Real message.** Send something useful, e.g. `what's a good dinner spot in SF tonight?`
   - ✅ Expect a useful reply in ~10–40s (iMessage = autoreply mode → analyzer evaluates every message → DIRECT_REPLY or NEW_ACTION → agent responds; may web-search).
6. **Dashboard.** `localhost:3000/dashboard` → the iMessage group appears → click in → run timeline (analyzer reasoning, tool calls, response) renders.

---

## Part 6 — Verification queries

```sql
-- group created + claimed?
select id, name, platform, bluebubbles_chat_guid, registered_by_user_id, claim_prompt_sent_at
from groups where platform = 'imessage' order by created_at desc limit 3;

-- messages persisted (user + bot)?
select is_bot, text, bluebubbles_message_guid, ts
from messages where platform = 'imessage' order by ts desc limit 10;

-- analyzer/agent runs?
select decision, status, intent_summary, created_at
from agent_runs order by created_at desc limit 5;
```

---

## Part 7 — Troubleshooting

| Symptom | Fix |
|---|---|
| No `POST /api/imessage` in Next logs | BlueBubbles webhook URL wrong, or "New Messages" event not enabled. URL must be exactly `http://localhost:3000/api/imessage?secret=<secret>`. |
| `401` on `/api/imessage` | `?secret=` in the webhook URL ≠ `BLUEBUBBLES_WEBHOOK_SECRET` in `.env.local`. Make identical, restart `pnpm dev`. |
| Webhook hits but `{ignored:"incomplete"}` on real messages | BlueBubbles payload differs from the assumed shape. Check `messages.raw` / Next logs for the raw payload and we adjust the parser. |
| Bot doesn't reply / send fails | BlueBubbles missing Full Disk Access / Accessibility / Automation (control Messages); or `BLUEBUBBLES_PASSWORD`/`SERVER_URL` wrong. Look for `[bluebubbles] send` errors in Next logs. |
| Webhook arrives, no run/reply | Check `localhost:8288` → Events for `message.received.ambient`, Runs for analyzer. If no events, the SDK is trying prod Cloud — unset `INNGEST_*` keys locally. |
| `claim` says "invalid" | Code expired or already used — generate a fresh one at `/dashboard/connect`. |
| Group stays silent after claim | Confirm `registered_by_user_id` is set (Part 6 query). Unclaimed groups are intentionally inert. |

---

## Appendix — going to prod / a dedicated Mac mini

Same code; two differences from local:

1. **The send direction needs the Mac reachable from Vercel.** Locally that's `localhost`. In prod, Vercel → BlueBubbles must cross the internet, so enable **BlueBubbles' Cloudflare tunnel** (Settings → Connection → Proxy) and set `BLUEBUBBLES_SERVER_URL` (in Vercel env) to that public tunnel URL.
2. **Webhook → Vercel.** Point the BlueBubbles webhook at `https://<your-vercel>/api/imessage?secret=<secret>` and set the same env vars (`BLUEBUBBLES_PASSWORD`, `BLUEBUBBLES_WEBHOOK_SECRET`, `BLUEBUBBLES_SEND_METHOD`, `BLUEBUBBLES_BOT_HANDLE`) in Vercel.
3. **Dedicated Mac mini:** the whole machine is the Sidekick user (no fast-switching). Set auto-login, "never sleep", and BlueBubbles to launch on boot (it installs a launchd service for auto-restart). For a phone-number handle (vs email), register a SIM-activated number to the Apple ID.
