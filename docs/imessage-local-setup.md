# iMessage Setup & E2E Test (BlueBubbles, poll-based)

End-to-end guide to run Sidekick's iMessage integration: a dedicated Apple ID
in a separate macOS user, BlueBubbles Server as the bridge, and Sidekick
(local or on Vercel). The Mac never exposes anything to the internet — the send
path is a **poll-based outbox**: Sidekick enqueues outbound iMessages, and a
small bridge script on the Mac polls for them and dispatches via localhost
BlueBubbles.

## Architecture

Two directions, both initiated **from the Mac** — Sidekick (Vercel or your dev
server) never connects to the laptop:

- **Receive:** BlueBubbles posts `new-message` webhooks → `/api/imessage`
  (authed via `?secret=`). The route self-heals the group, handles
  `claim <code>` + the inert-until-claimed gate, persists the message, and emits
  the Inngest `message.received.ambient` event. This is an outbound call from
  the Mac, so it works against a remote Sidekick with no tunnel.
- **Send:** Sidekick writes outbound iMessages to the `outbound_messages` table
  (via `lib/messaging.ts`). The bridge (`scripts/imessage-bridge.mjs`, running
  on the Mac) polls `GET /api/imessage/outbox` for queued sends, dispatches each
  via the **localhost** BlueBubbles REST API (`POST /api/v1/message/text`), and
  acks the result to `POST /api/imessage/outbox/ack`.

```
Your iPhone / personal Apple ID
        │  (iMessage, via Apple's servers)
        ▼
Sidekick Apple ID  ──signed into──▶  Messages.app  (in the "Sidekick" macOS user)
                                          │  writes ~/Library/Messages/chat.db
                                          ▼
                                   BlueBubbles Server  (localhost:1234)
                                          │  ▲
              ┌── webhook POST ───────────┘  │ localhost REST send
              ▼                               │ (POST /api/v1/message/text)
   {Sidekick}/api/imessage                    │
   (receive: persist + emit Inngest)   scripts/imessage-bridge.mjs  (on the Mac)
              │                               │  ▲
              ▼                               │  │ poll + ack (outbound HTTPS)
   message.received.ambient                   ▼  │
              ▼                       {Sidekick}/api/imessage/outbox(/ack)
   analyzer → agent-executor ──▶ sendMessage() ──▶ INSERT outbound_messages (pending)
                                          (drained by the bridge above)
```

Every arrow touching Sidekick is **outbound from the Mac**. Vercel holds no
BlueBubbles credentials and never opens a connection to the laptop — so no
tunnel, and the BlueBubbles password stays on the Mac.

If the bridge or the Mac is down, outbound replies simply queue in
`outbound_messages` and drain when it comes back (delayed, never lost).

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
   - **Password:** Settings → Connection → set/note the server password → this is `BLUEBUBBLES_PASSWORD` (lives on the bridge, in `.env.bridge`).
   - **Server URL/port:** default `http://localhost:1234` → this is the bridge's `BLUEBUBBLES_LOCAL_URL`. The bridge always talks to BlueBubbles over **localhost** — no Cloudflare/ngrok proxy is needed in any environment (the poll model means Sidekick never connects in).
   - **Private API:** leave **OFF** (we use AppleScript). You can switch to Private API later for richer group features (needs a SIP tweak + helper bundle).
   - **Webhooks:** Settings → API & Webhooks → *Add Webhook* →
     URL: `http://localhost:3000/api/imessage?secret=<BLUEBUBBLES_WEBHOOK_SECRET>`
     Event: enable **"New Messages"** (others are fine; we filter to new-message). Save.
4. **Disable sleep** so the background session keeps polling: System Settings → Lock Screen → never sleep; or run `caffeinate -s` in a Terminal in the Sidekick session.

> ⚠️ Keep the Sidekick user **switched** (logged in), never **logged out** — a logged-out user's processes stop. Reboots require re-login.

---

## Part 3 — env vars + schema

The credentials are **split**: Sidekick (the Next app, local `.env.local` or
Vercel env) holds only the shared secret + bot handle; the BlueBubbles server
URL and password live on the **bridge** (`.env.bridge` on the Mac, never on
Vercel).

1. **Generate the webhook secret:** `openssl rand -hex 32` (use the SAME value in
   the BlueBubbles webhook URL above, in Sidekick's env, and in the bridge's
   `.env.bridge`).
2. **Sidekick app env** (`.env.local` locally, or Vercel → Settings → Environment
   Variables) — for iMessage it needs only these two:
   ```
   BLUEBUBBLES_WEBHOOK_SECRET=<the openssl value — must match the ?secret= in the webhook URL AND the bridge>
   BLUEBUBBLES_BOT_HANDLE=<the Sidekick Apple ID email>   # shown on /dashboard/connect
   ```
   It no longer needs `BLUEBUBBLES_SERVER_URL` / `BLUEBUBBLES_PASSWORD` /
   `BLUEBUBBLES_SEND_METHOD` — those moved to the bridge.
3. **Bridge env** (`.env.bridge` on the Mac, gitignored): copy
   `.env.bridge.example` → `.env.bridge` and fill it in:
   ```
   SIDEKICK_BASE_URL=https://your-app.vercel.app   # or http://localhost:3000 for local dev
   BLUEBUBBLES_WEBHOOK_SECRET=<same secret as the app>
   BLUEBUBBLES_LOCAL_URL=http://localhost:1234
   BLUEBUBBLES_PASSWORD=<the BlueBubbles server password>
   BLUEBUBBLES_SEND_METHOD=apple-script
   POLL_INTERVAL_MS=2000
   ```
4. **Schema:** the poll model adds the `outbound_messages` table (and earlier
   migrations added `bluebubbles_chat_guid`, `bluebubbles_message_guid`,
   `bluebubbles_handle`). On a fresh clone run `pnpm db:push`; on prod the
   Vercel build applies it via `db:push:ci`.
5. **Inngest local routing:** make sure `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY`
   are **NOT set** in `.env.local`, so events route to the local Inngest dev
   server (not prod Cloud).

---

## Part 4 — Startup

In your **main** user session (where the repo lives):

| Terminal | Command | What |
|---|---|---|
| 1 | `pnpm dev` | Next.js on `localhost:3000` (skip if testing against Vercel) |
| 2 | `pnpm inngest:dev` | Inngest dev server on `localhost:8288` (auto-discovers `localhost:3000/api/inngest`) |
| 3 | (already running) | BlueBubbles Server in the Sidekick user session |

Then start the **bridge** (in the Sidekick session, or anywhere on the Mac that
can reach `localhost:1234`):

```
node --env-file=.env.bridge scripts/imessage-bridge.mjs
```

(`--env-file` needs Node 20+ — the repo's CI Node. Alternatively export the env
vars yourself and run `pnpm imessage:bridge`.) On start it logs
`[bridge] starting — polling <SIDEKICK_BASE_URL> …`.

- **No ngrok needed** for iMessage — receive is an outbound webhook from the Mac,
  send is a poll from the Mac. (Telegram would still need ngrok — separate.)
- **Verify Inngest registered:** open `localhost:8288` → Apps → "sidekick" with
  `analyzer-mention`, `analyzer-ambient`, `agent-executor`.

### Auto-start the bridge on the Mac (launchd)

For a productized always-on bridge, install a LaunchAgent so it starts at login
and restarts on crash. Create
`~/Library/LaunchAgents/codes.sidekick.imessage-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>codes.sidekick.imessage-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>      <!-- `which node` on the Mac -->
    <string>--env-file=/Users/you/sidekick/.env.bridge</string>
    <string>/Users/you/sidekick/scripts/imessage-bridge.mjs</string>
  </array>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>StandardOutPath</key>  <string>/tmp/sidekick-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/sidekick-bridge.err.log</string>
</dict>
</plist>
```

Load it: `launchctl load ~/Library/LaunchAgents/codes.sidekick.imessage-bridge.plist`
(use absolute paths; `which node` for the node path — a Homebrew/nvm node lives
elsewhere). Tail `/tmp/sidekick-bridge.log` to watch sends.

---

## Part 5 — E2E test walkthrough

Message the bot **from your personal iMessage** (iPhone, or your main macOS user's Messages signed into *your* Apple ID) → to the Sidekick email handle. Make sure the **bridge is running** (Part 4) — without it, replies queue but never send.

1. **Start the chat.** New iMessage to the Sidekick email. For a **group** test: create a group with you + the Sidekick email (+ optionally a friend).
2. **Send any message** (e.g. `hey`).
   - ✅ Expect within ~2–5s: Sidekick replies with the **claim prompt** ("I'm not active in this chat yet… go to …/dashboard/connect … send `claim <code>`").
   - Under the hood: chat.db poll → webhook → `/api/imessage` → group self-healed (unclaimed) → claim prompt **enqueued to `outbound_messages`** → the bridge's next poll dispatches it via localhost BlueBubbles → ack. Next logs show `POST /api/imessage 200` and `GET /api/imessage/outbox 200`; the bridge logs `[bridge] sent …`.
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

-- outbound queue drained by the bridge?
select status, attempts, text, external_message_id, error_text, created_at
from outbound_messages order by created_at desc limit 10;
```

---

## Part 7 — Troubleshooting

| Symptom | Fix |
|---|---|
| No `POST /api/imessage` in Next logs | BlueBubbles webhook URL wrong, or "New Messages" event not enabled. URL must be exactly `http://localhost:3000/api/imessage?secret=<secret>`. |
| `401` on `/api/imessage` | `?secret=` in the webhook URL ≠ `BLUEBUBBLES_WEBHOOK_SECRET` in `.env.local`. Make identical, restart `pnpm dev`. |
| Webhook hits but `{ignored:"incomplete"}` on real messages | BlueBubbles payload differs from the assumed shape. Check `messages.raw` / Next logs for the raw payload and we adjust the parser. |
| Bot doesn't reply / send fails | First check the **bridge** is running (`[bridge] starting …` / `[bridge] sent …` in its log). Then: BlueBubbles missing Full Disk Access / Accessibility / Automation (control Messages); or `BLUEBUBBLES_PASSWORD`/`BLUEBUBBLES_LOCAL_URL` wrong in `.env.bridge`. Look for `[bridge] send failed` lines, or query `select status, attempts, error_text from outbound_messages order by created_at desc limit 10;`. |
| Replies queue but never send | The bridge isn't running or can't reach `BLUEBUBBLES_LOCAL_URL`. Rows sit `pending`/`sending` in `outbound_messages` and drain once the bridge is back. A `sending` row stuck >2 min is auto-reclaimed to `pending` on the next poll. |
| `401` on `/api/imessage/outbox` (bridge log) | `BLUEBUBBLES_WEBHOOK_SECRET` in `.env.bridge` ≠ the one in Sidekick's env. Make identical. |
| Webhook arrives, no run/reply | Check `localhost:8288` → Events for `message.received.ambient`, Runs for analyzer. If no events, the SDK is trying prod Cloud — unset `INNGEST_*` keys locally. |
| `claim` says "invalid" | Code expired or already used — generate a fresh one at `/dashboard/connect`. |
| Group stays silent after claim | Confirm `registered_by_user_id` is set (Part 6 query). Unclaimed groups are intentionally inert. |

---

## Appendix — going to prod / a dedicated Mac mini

Same code, and thanks to the poll model **no tunnel is ever required** — the Mac
only makes outbound calls in both directions. Differences from a local Sidekick:

1. **Point the bridge at the public Sidekick.** Set `SIDEKICK_BASE_URL` in
   `.env.bridge` to the Vercel URL (`https://<your-vercel>`). The bridge keeps
   talking to BlueBubbles over `localhost:1234` — that never changes. **No
   Cloudflare/ngrok proxy on BlueBubbles** (the old direct-send model needed it;
   the outbox model does not).
2. **Webhook → Vercel.** Point the BlueBubbles webhook at
   `https://<your-vercel>/api/imessage?secret=<secret>`. In the Vercel env set
   only `BLUEBUBBLES_WEBHOOK_SECRET` (same value) and `BLUEBUBBLES_BOT_HANDLE` —
   Vercel holds no BlueBubbles server URL or password.
3. **Run the bridge as a LaunchAgent** (see Part 4) so it auto-starts and
   restarts on crash.
4. **Dedicated Mac mini:** the whole machine is the Sidekick user (no
   fast-switching). Set auto-login, "never sleep", and BlueBubbles to launch on
   boot. For a phone-number handle (vs email), register a SIM-activated number to
   the Apple ID.
