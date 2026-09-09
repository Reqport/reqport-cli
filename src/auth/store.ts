/**
 * Credential storage for `qp login` (portal-pairing). A single JSON file in the
 * config dir, written 0600 (best-effort on Windows). Holds the rqk_live_ API key
 * the portal minted and relayed to the CLI, plus local-only metadata. The key is
 * NEVER logged.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { configDir, credentialPath } from "./paths.js";

export type StoredCredential = {
  /** The rqk_live_ API key relayed from the portal. */
  value: string;
  kind: "apikey";
  /** Environment the key was minted for (sandbox | uat | prod). */
  env: string;
  keyId?: string;
  scopes?: string[];
  /** ISO expiry (or null/absent for non-expiring). */
  expiresAt?: string | null;
  /** Portal the pairing was done against (for reference / console links). */
  portalUrl?: string;
  savedAt: number;
};

export function loadCredential(): StoredCredential | undefined {
  const p = credentialPath();
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as StoredCredential;
    if (!parsed.value || parsed.kind !== "apikey") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveCredential(c: StoredCredential): void {
  mkdirSync(configDir(), { recursive: true });
  const p = credentialPath();
  writeFileSync(p, JSON.stringify(c, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows ACLs — best effort. */
  }
}

export function clearCredential(): boolean {
  const p = credentialPath();
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}
