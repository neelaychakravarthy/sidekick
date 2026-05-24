import { Spectrum, type Space, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// Lazy SDK init pattern. Caches the in-flight promise AND the resolved
// instance on globalThis so two concurrent cold-start requests don't
// double-construct.
declare global {
  var __sidekick_spectrum: Awaited<ReturnType<typeof Spectrum>> | undefined;
  var __sidekick_spectrum_promise:
    | Promise<Awaited<ReturnType<typeof Spectrum>>>
    | undefined;
}

async function getApp() {
  if (globalThis.__sidekick_spectrum) return globalThis.__sidekick_spectrum;
  if (globalThis.__sidekick_spectrum_promise) {
    return globalThis.__sidekick_spectrum_promise;
  }

  const projectId = process.env.PHOTON_PROJECT_ID;
  const projectSecret = process.env.PHOTON_PROJECT_SECRET;
  if (!projectId || !projectSecret) {
    throw new Error(
      "PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET must be set to use the Photon SDK.",
    );
  }

  globalThis.__sidekick_spectrum_promise = Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  }).then((app) => {
    globalThis.__sidekick_spectrum = app;
    return app;
  });

  return globalThis.__sidekick_spectrum_promise;
}

function inferSpaceType(spaceId: string): "dm" | "group" {
  // Per Spectrum docs: iMessage DM space.id has the form "any;-;+<E.164>".
  // Group spaces are opaque chat GUIDs.
  return /^any;-;\+/.test(spaceId) ? "dm" : "group";
}

/**
 * Send a text message via Photon Spectrum (iMessage) to the given space.
 *
 * The SDK's `app.send(space, content)` reads space.id, space.__platform,
 * space.type, and space.phone — none of the Space interface's runtime
 * methods. We construct a minimal Space-shaped object from those four fields
 * and cast through `unknown`, accepting the (real) trade-off: any Space-method
 * call inside the SDK's send pipeline would NPE. The iMessage send action
 * (chunk-FPYXHZZA.js line 2134) doesn't call any.
 *
 * Returns the sent message's id when the SDK surfaces it, or null otherwise.
 */
export async function sendPhotonMessage(
  spaceId: string,
  body: string,
): Promise<string | null> {
  const linePhone = process.env.PHOTON_LINE_NUMBER;
  if (!linePhone) {
    throw new Error(
      "PHOTON_LINE_NUMBER must be set to send iMessages. Add your Photon line number (e.g. +15551234567) to .env.local.",
    );
  }

  const app = await getApp();

  const space = {
    id: spaceId,
    __platform: "iMessage",
    type: inferSpaceType(spaceId),
    phone: linePhone,
  } as unknown as Space;

  const result = await app.send(space, text(body));
  const maybeId =
    (result as { id?: string } | null | undefined)?.id ?? null;
  return maybeId;
}
