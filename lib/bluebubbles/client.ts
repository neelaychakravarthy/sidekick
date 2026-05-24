const BB_URL = process.env.BLUEBUBBLES_SERVER_URL;
const BB_PASSWORD = process.env.BLUEBUBBLES_PASSWORD;

/**
 * Sends a text iMessage via BlueBubbles Server REST API.
 * Returns the BlueBubbles message guid, or null on failure.
 * Best effort — callers should not throw on null.
 */
export async function sendBluebubblesMessage(
  chatGuid: string,
  text: string,
): Promise<string | null> {
  if (!BB_URL || !BB_PASSWORD) {
    console.warn(
      "[bluebubbles] BLUEBUBBLES_SERVER_URL or BLUEBUBBLES_PASSWORD missing",
    );
    return null;
  }

  const url = `${BB_URL.replace(/\/$/, "")}/api/v1/message/text?password=${encodeURIComponent(BB_PASSWORD)}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatGuid,
        message: text,
        method: "apple-script",
        tempGuid: `sidekick-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "<unreadable>");
      console.error(
        "[bluebubbles] send HTTP",
        resp.status,
        errText.slice(0, 200),
      );
      return null;
    }

    const data = (await resp.json()) as {
      status?: number;
      data?: { guid?: string };
    };
    return data.data?.guid ?? null;
  } catch (err) {
    console.error("[bluebubbles] send error", err);
    return null;
  }
}
