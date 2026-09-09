/**
 * Session glue: run a login flow and persist tokens; resolve a valid bearer
 * (auto-refreshing on expiry); and resolve the credential the responder
 * commands should use.
 *
 * Credential precedence for responder commands (requests/respond):
 *   1. REQPORT_API_KEY (rqk_live_...)  — agents / CI
 *   2. a stored `qp login` JWT         — humans
 * Key-management commands (keys create/list/revoke) always require the JWT.
 */

import type { Credential } from "../client.js";
import { readApiKey } from "../env.js";
import {
  discover,
  loginAuthCode,
  loginDeviceCode,
  refresh,
  resolveOidcConfig,
  type LoginProgress,
  type OidcConfig,
  type TokenResponse,
} from "./oidc.js";
import { clearTokens, loadTokens, saveTokens, type StoredTokens } from "./store.js";

/** Which stored token qp sends to Vanta. Access token by default. */
function bearerSource(): "access_token" | "id_token" {
  return process.env.QP_JWT_SOURCE === "id_token" ? "id_token" : "access_token";
}

const SKEW_MS = 60_000; // refresh a minute early

function toStored(
  cfg: OidcConfig,
  t: TokenResponse,
  prev?: StoredTokens
): StoredTokens {
  const expiresIn = t.expires_in ?? 3600;
  return {
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    accessToken: t.access_token,
    idToken: t.id_token ?? prev?.idToken,
    refreshToken: t.refresh_token ?? prev?.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: t.scope ?? prev?.scope,
    bearerSource: bearerSource(),
    savedAt: Date.now(),
  };
}

export type LoginOptions = {
  device?: boolean;
  issuer?: string;
  clientId?: string;
  scope?: string;
};

/** Run the interactive login flow and persist tokens. Returns a short summary. */
export async function performLogin(
  opts: LoginOptions,
  progress: LoginProgress
): Promise<{ issuer: string; clientId: string; scope: string; expiresAt: number }> {
  const cfg = resolveOidcConfig({
    issuer: opts.issuer,
    clientId: opts.clientId,
    scope: opts.scope,
  });
  const disc = await discover(cfg.issuer);
  const tokens = opts.device
    ? await loginDeviceCode(cfg, disc, progress)
    : await loginAuthCode(cfg, disc, progress);
  const stored = toStored(cfg, tokens);
  saveTokens(stored);
  return { issuer: cfg.issuer, clientId: cfg.clientId, scope: cfg.scope, expiresAt: stored.expiresAt };
}

export function logout(): boolean {
  return clearTokens();
}

/** Is there a stored login (regardless of expiry)? */
export function isLoggedIn(): boolean {
  return Boolean(loadTokens());
}

/**
 * Return a valid bearer JWT string, refreshing if expired. Throws with a
 * `qp login` hint when there is no usable session.
 */
export async function getValidJwt(): Promise<string> {
  let t = loadTokens();
  if (!t) {
    throw new Error("Not logged in. Run `qp login` first.");
  }
  if (Date.now() < t.expiresAt - SKEW_MS) {
    return chooseBearer(t);
  }
  // Expired — try to refresh.
  if (!t.refreshToken) {
    throw new Error("Session expired and no refresh token is stored. Run `qp login` again.");
  }
  const disc = await discover(t.issuer);
  const refreshed = await refresh({ clientId: t.clientId }, disc.token_endpoint, t.refreshToken);
  t = toStored({ issuer: t.issuer, clientId: t.clientId, scope: t.scope ?? "" }, refreshed, t);
  saveTokens(t);
  return chooseBearer(t);
}

function chooseBearer(t: StoredTokens): string {
  if (t.bearerSource === "id_token" && t.idToken) return t.idToken;
  return t.accessToken;
}

/**
 * Credential for responder commands: API key if set, else a logged-in JWT,
 * else undefined (caller decides whether to error).
 */
export async function resolveResponderCredential(): Promise<Credential | undefined> {
  const key = readApiKey();
  if (key) return { value: key, kind: "apikey" };
  if (isLoggedIn()) return { value: await getValidJwt(), kind: "jwt" };
  return undefined;
}

/** Require a responder credential or throw an actionable error. */
export async function requireResponderCredential(): Promise<Credential> {
  const cred = await resolveResponderCredential();
  if (!cred) {
    throw new Error(
      "No credential. Set REQPORT_API_KEY (rqk_live_...) for automation, or run `qp login` for interactive use."
    );
  }
  return cred;
}

/** Require a human JWT credential (for key management). */
export async function requireJwtCredential(): Promise<Credential> {
  return { value: await getValidJwt(), kind: "jwt" };
}

/** A short, non-secret description of the active login for status output. */
export function loginSummary(): Record<string, unknown> {
  const t = loadTokens();
  if (!t) return { loggedIn: false };
  return {
    loggedIn: true,
    issuer: t.issuer,
    clientId: t.clientId,
    scope: t.scope,
    bearerSource: t.bearerSource,
    expiresAt: new Date(t.expiresAt).toISOString(),
    expired: Date.now() >= t.expiresAt,
    hasRefreshToken: Boolean(t.refreshToken),
  };
}
