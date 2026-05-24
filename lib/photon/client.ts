import { Spectrum, type SpectrumInstance } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// Lazy SDK init pattern. Caches the in-flight promise AND the resolved
// instance on globalThis so two concurrent cold-start requests don't
// double-construct.
declare global {
  var __sidekick_spectrum: SpectrumInstance | undefined;
  var __sidekick_spectrum_promise: Promise<SpectrumInstance> | undefined;
}

async function getApp(): Promise<SpectrumInstance> {
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

/**
 * Send a text message via Photon Spectrum (iMessage).
 *
 * Returns the sent message's id when available, or null if the SDK didn't
 * surface one.
 *
 * KNOWN GAP (spectrum-ts 1.12.0): the SDK's public surface offers no
 * `getSpace(id)` / send-by-id call. `SpectrumInstance.send(space, content)`
 * requires a `Space` object, which is normally obtained from the inbound
 * `app.messages` async iterator OR constructed via
 * `imessage(app).space(users, params)` — both require knowing the
 * participant users (with phone numbers), which a webhook does not give us.
 *
 * Until the SDK exposes a send-by-id (or until we wire the streaming model
 * end-to-end), this function will throw at runtime. The shape is stable so
 * the messaging-router callsite is ready when the gap is closed.
 */
export async function sendPhotonMessage(
  spaceId: string,
  text: string,
): Promise<string | null> {
  // Force the lazy init to surface env-var errors first if any.
  await getApp();
  // params kept on the signature for the eventual SDK fix; reference them
  // explicitly so the runtime error preserves the call context.
  void spaceId;
  void text;
  throw new Error(
    "[photon] sendPhotonMessage: spectrum-ts 1.12.0 has no send-by-id API. " +
      "iMessage send currently requires a Space obtained from the inbound " +
      "stream (app.messages). Wire the streaming model or upgrade once a " +
      "send-by-id is published.",
  );
}
