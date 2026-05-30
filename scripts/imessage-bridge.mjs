#!/usr/bin/env node
/**
 * Sidekick iMessage bridge — runs ON THE MAC alongside BlueBubbles.
 *
 * This is NOT part of the Vercel/serverless deploy. It is an intentionally
 * long-running standalone process (the CLAUDE.md "no long-running Node /
 * no polling loops" rule applies to the deployed serverless app, not to this
 * laptop-side bridge).
 *
 * It polls Sidekick (on Vercel) for queued outbound iMessages, sends each via
 * the LOCAL BlueBubbles REST API (localhost), and acks the result. Vercel never
 * reaches this machine — every call here is outbound HTTPS. BlueBubbles
 * credentials live only here, never on Vercel.
 *
 *   node scripts/imessage-bridge.mjs
 */

const SIDEKICK_BASE_URL = process.env.SIDEKICK_BASE_URL;
const POLL_SECRET = process.env.BLUEBUBBLES_WEBHOOK_SECRET;
const BB_LOCAL_URL = process.env.BLUEBUBBLES_LOCAL_URL ?? "http://localhost:1234";
const BB_PASSWORD = process.env.BLUEBUBBLES_PASSWORD;
const BB_METHOD = process.env.BLUEBUBBLES_SEND_METHOD ?? "apple-script";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 2000);

function requireEnv(name, value) {
  if (!value) {
    console.error(`[bridge] missing required env: ${name}`);
    process.exit(1);
  }
}
requireEnv("SIDEKICK_BASE_URL", SIDEKICK_BASE_URL);
requireEnv("BLUEBUBBLES_WEBHOOK_SECRET", POLL_SECRET);
requireEnv("BLUEBUBBLES_PASSWORD", BB_PASSWORD);

const base = SIDEKICK_BASE_URL.replace(/\/$/, "");
const outboxUrl = `${base}/api/imessage/outbox?secret=${encodeURIComponent(POLL_SECRET)}`;
const ackUrl = `${base}/api/imessage/outbox/ack?secret=${encodeURIComponent(POLL_SECRET)}`;
const bbUrl = `${BB_LOCAL_URL.replace(/\/$/, "")}/api/v1/message/text?password=${encodeURIComponent(BB_PASSWORD)}`;

async function sendViaBlueBubbles(chatGuid, text, rowId) {
  // Stable tempGuid derived from the outbox row id → a re-send (after a
  // stale-reclaim) dedups on the BlueBubbles side instead of double-posting.
  const tempGuid = `sidekick-${rowId}`;
  const resp = await fetch(bbUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatGuid, message: text, method: BB_METHOD, tempGuid }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "<unreadable>");
    throw new Error(`BlueBubbles ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => ({}));
  return data?.data?.guid ?? null;
}

async function ack(id, success, externalMessageId, error) {
  try {
    await fetch(ackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, success, externalMessageId, error }),
    });
  } catch (err) {
    console.error("[bridge] ack failed", id, err?.message ?? err);
  }
}

async function tick() {
  let messages = [];
  try {
    const resp = await fetch(outboxUrl);
    if (!resp.ok) {
      console.error("[bridge] outbox poll HTTP", resp.status);
      return;
    }
    const data = await resp.json();
    messages = Array.isArray(data?.messages) ? data.messages : [];
  } catch (err) {
    // Sidekick unreachable (offline, deploy in progress) — just retry next tick.
    console.error("[bridge] outbox poll error", err?.message ?? err);
    return;
  }

  for (const m of messages) {
    if (!m?.id || !m?.bluebubblesChatGuid) {
      await ack(m?.id, false, null, "missing chatGuid");
      continue;
    }
    try {
      const guid = await sendViaBlueBubbles(m.bluebubblesChatGuid, m.text, m.id);
      await ack(m.id, true, guid, null);
      console.log(`[bridge] sent ${m.id} -> ${m.bluebubblesChatGuid}`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      await ack(m.id, false, null, msg);
      console.error(`[bridge] send failed ${m.id}: ${msg}`);
    }
  }
}

console.log(`[bridge] starting — polling ${base} every ${POLL_INTERVAL_MS}ms, BlueBubbles at ${BB_LOCAL_URL}`);

let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

while (running) {
  await tick();
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
console.log("[bridge] stopped");
