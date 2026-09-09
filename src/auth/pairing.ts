/**
 * Portal-pairing login flow (the ONLY `qp login` mode).
 *
 * No Signicat client, no device flow, no localhost callback. The CLI:
 *   1. generates a secret `verifier` + `state`, and `challenge = b64url(SHA256(verifier))`;
 *   2. opens the portal's CLI-auth page (which reuses the portal's existing
 *      Signicat session) with `state`, `challenge`, `env`;
 *   3. polls the portal until it mints a key and relays it back, matched by the
 *      caller proving knowledge of `verifier`.
 *
 * The user visually matches a short confirmation code (a prefix of `state`) on
 * the portal page before approving.
 */

import { createPkce, randomState } from "./pkce.js";
import { openBrowser } from "./openBrowser.js";

/** Canonical prod console. Override with --portal-url / QP_PORTAL_URL for sandbox/aurora. */
export const DEFAULT_PORTAL_URL = "https://reqport.com";

export type PairingResult = {
  apiKey: string;
  keyId?: string;
  env?: string;
  scopes?: string[];
  expiresAt?: string | null;
};

export type PairingProgress = (msg: string) => void;

export type PairingOptions = {
  portalUrl: string;
  env: string;
  name?: string;
  locale?: string;
  timeoutMs?: number;
  intervalMs?: number;
};

/** The developer console URL where keys are managed by a human. */
export function developerConsoleUrl(portalUrl: string, locale = "en"): string {
  return `${portalUrl.replace(/\/$/, "")}/${locale}/developer`;
}

/**
 * Anti-phishing visual confirmation code. MUST byte-match the portal's algorithm
 * (reqport-portal #544): strip non-alphanumeric chars from `state`, take the
 * first 8, uppercase. The terminal and the console page then always agree.
 */
export function confirmationCode(state: string): string {
  return state.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
}

export async function runPairing(
  opts: PairingOptions,
  progress: PairingProgress
): Promise<PairingResult> {
  const portalUrl = opts.portalUrl.replace(/\/$/, "");
  const locale = opts.locale || "en";
  const intervalMs = opts.intervalMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  const { verifier, challenge } = createPkce(); // challenge = b64url(SHA256(verifier))
  const state = randomState();
  const confirmation = confirmationCode(state);

  const authUrl = new URL(`${portalUrl}/${locale}/developer/cli-auth`);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("challenge", challenge);
  authUrl.searchParams.set("env", opts.env);
  if (opts.name) authUrl.searchParams.set("name", opts.name);

  progress(
    `Confirmation code: ${confirmation}\n` +
      `Opening the Reqport console to authorize this CLI:\n  ${authUrl.toString()}\n` +
      `Check that the page shows the same code, then approve. (Ctrl+C to cancel.)`
  );
  openBrowser(authUrl.toString());

  const pollUrl = `${portalUrl}/api/developer/cli-auth/poll`;
  const deadline = Date.now() + timeoutMs;

  // Clean Ctrl+C: reject the wait so the caller can print a tidy message.
  let onSigint: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onSigint = () => reject(new Error("Login cancelled."));
    process.once("SIGINT", onSigint);
  });

  try {
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error("Login timed out after 5 minutes — no approval received. Run `qp login` again.");
      }
      const result = await Promise.race([pollOnce(pollUrl, state, verifier), cancelled]);
      if (result === "pending") {
        await Promise.race([sleep(intervalMs), cancelled]);
        continue;
      }
      if (result === "rate_limited") {
        // Back off one extra interval, then keep polling.
        await Promise.race([sleep(intervalMs * 2), cancelled]);
        continue;
      }
      return result;
    }
  } finally {
    if (onSigint) process.removeListener("SIGINT", onSigint);
  }
}

async function pollOnce(
  pollUrl: string,
  state: string,
  verifier: string
): Promise<PairingResult | "pending" | "rate_limited"> {
  let res: Response;
  try {
    res = await fetch(pollUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ state, verifier }),
    });
  } catch (e) {
    // Transient network hiccup — treat as pending so we retry until the deadline.
    return "pending";
  }

  if (res.status === 202) return "pending";
  if (res.status === 429) return "rate_limited"; // retryable — back off and keep polling

  if (res.status === 200) {
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      apiKey?: string;
      keyId?: string;
      env?: string;
      scopes?: string[];
      expiresAt?: string | null;
    };
    if (!body.apiKey) {
      throw new Error("Portal returned 200 but no apiKey — cannot complete login.");
    }
    return {
      apiKey: body.apiKey,
      keyId: body.keyId,
      env: body.env,
      scopes: body.scopes,
      expiresAt: body.expiresAt ?? null,
    };
  }

  if (res.status === 400) {
    throw new Error("The portal rejected the pairing request (bad request). Run `qp login` again.");
  }
  if (res.status === 403) {
    throw new Error("The portal rejected the pairing (verifier mismatch). Run `qp login` again.");
  }
  if (res.status === 404) {
    throw new Error("Pairing session not found. Approve on the portal page, or run `qp login` again.");
  }
  if (res.status === 410) {
    throw new Error("Pairing session expired. Run `qp login` again.");
  }
  const text = await res.text().catch(() => "");
  throw new Error(`Pairing poll failed: HTTP ${res.status} ${text}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
