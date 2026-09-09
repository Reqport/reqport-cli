/**
 * Token storage for `qp login`. A single JSON file in the config dir, written
 * with 0600 permissions (best-effort on Windows). Holds the OAuth tokens and
 * the client/issuer they were minted against so refresh and env-portability
 * work without re-discovery each call. Tokens are NEVER logged.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { configDir, tokensPath } from "./paths.js";

export type StoredTokens = {
  issuer: string;
  clientId: string;
  /** Bearer for Vanta: a Signicat user JWT. Both kinds stored so switching is free. */
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  /** Epoch millis when the access token expires. */
  expiresAt: number;
  scope?: string;
  /** Which token qp sends to Vanta as the bearer (access_token | id_token). */
  bearerSource: "access_token" | "id_token";
  savedAt: number;
};

export function loadTokens(): StoredTokens | undefined {
  const p = tokensPath();
  if (!existsSync(p)) return undefined;
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as StoredTokens;
    if (!parsed.accessToken || !parsed.issuer) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveTokens(t: StoredTokens): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const p = tokensPath();
  writeFileSync(p, JSON.stringify(t, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows ACLs — best effort. */
  }
}

export function clearTokens(): boolean {
  const p = tokensPath();
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}
