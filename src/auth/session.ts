/**
 * Session glue for the portal-pairing model.
 *
 * Credential precedence for responder commands (requests/respond):
 *   1. REQPORT_API_KEY (rqk_live_...)  — agents / CI
 *   2. the API key stored by `qp login` — humans
 * Both are `kind:"apikey"` — the responder loop and MCP consume them identically.
 */

import type { Credential } from "../client.js";
import { readApiKey } from "../env.js";
import { clearCredential, loadCredential } from "./store.js";

export function isLoggedIn(): boolean {
  return Boolean(loadCredential());
}

export function logout(): boolean {
  return clearCredential();
}

/**
 * Credential for responder commands: REQPORT_API_KEY if set, else the stored
 * paired key, else undefined (caller decides whether to error). Async for call-
 * site stability.
 */
export async function resolveResponderCredential(): Promise<Credential | undefined> {
  const key = readApiKey();
  if (key) return { value: key, kind: "apikey" };
  const stored = loadCredential();
  if (stored) return { value: stored.value, kind: "apikey" };
  return undefined;
}

/** Require a responder credential or throw an actionable error. */
export async function requireResponderCredential(): Promise<Credential> {
  const cred = await resolveResponderCredential();
  if (!cred) {
    throw new Error(
      "No credential. Set REQPORT_API_KEY (rqk_live_...) for automation, or run `qp login` to pair with the console."
    );
  }
  return cred;
}

/** A non-secret, LOCAL-ONLY description of the stored login for status output. */
export function loginSummary(): Record<string, unknown> {
  const c = loadCredential();
  if (!c) return { loggedIn: false };
  return {
    loggedIn: true,
    env: c.env,
    keyId: c.keyId ?? null,
    scopes: c.scopes ?? [],
    expiresAt: c.expiresAt ?? null,
    portalUrl: c.portalUrl ?? null,
    savedAt: new Date(c.savedAt).toISOString(),
  };
}
