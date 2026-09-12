/**
 * Credential storage for `qp login` (portal-pairing). Holds the rqk_live_ API
 * key the portal minted and relayed to the CLI, plus local-only metadata. Files
 * are written 0600 (best-effort on Windows). The key is NEVER logged.
 *
 * Two layers, both in the config dir:
 *   - `credential.json`          — the ACTIVE credential (what commands use).
 *   - `credential.<env>.json`    — a per-env copy, so `qp use <env>` can switch
 *                                  the active env among stored credentials.
 * The active file is the source of truth for the active env; the per-env files
 * are the pool `qp use` selects from. A credential written by an older version
 * (active file only, no per-env copy) still loads and is treated as the stored
 * credential for its own env.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { configDir, credentialPath, credentialPathFor } from "./paths.js";

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

function readFrom(p: string): StoredCredential | undefined {
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as StoredCredential;
    if (!parsed.value || parsed.kind !== "apikey") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeTo(p: string, c: StoredCredential): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows ACLs — best effort. */
  }
}

/** The active credential (what commands use), or undefined if not logged in. */
export function loadCredential(): StoredCredential | undefined {
  return readFrom(credentialPath());
}

/** The env of the active credential, if any. Drives the default target env. */
export function activeEnv(): string | undefined {
  return loadCredential()?.env;
}

/**
 * The stored credential for a specific env, if one is stored. Falls back to the
 * active credential when it happens to be for `env` (covers credentials written
 * by an older version that never wrote a per-env copy).
 */
export function loadCredentialFor(env: string): StoredCredential | undefined {
  const perEnv = readFrom(credentialPathFor(env));
  if (perEnv) return perEnv;
  const active = loadCredential();
  if (active && active.env === env) return active;
  return undefined;
}

/** All envs with a stored credential on this machine (active + per-env copies). */
export function listStoredEnvs(): string[] {
  const envs = new Set<string>();
  const active = loadCredential();
  if (active) envs.add(active.env);
  try {
    for (const name of readdirSync(configDir())) {
      const m = /^credential\.([a-z0-9_-]+)\.json$/i.exec(name);
      if (m && readFrom(credentialPathFor(m[1]))) envs.add(m[1]);
    }
  } catch {
    /* config dir may not exist yet — active-only. */
  }
  return [...envs].sort();
}

/**
 * Persist a credential: write both the active `credential.json` and the per-env
 * `credential.<env>.json`, so the freshly-minted env becomes active AND is
 * available to `qp use` later.
 */
export function saveCredential(c: StoredCredential): void {
  writeTo(credentialPathFor(c.env), c);
  writeTo(credentialPath(), c);
}

/**
 * Make `env` the active env by promoting its stored credential to the active
 * file. Returns the promoted credential, or undefined if none is stored for
 * `env` (caller tells the user to `qp login --env <env>` first).
 */
export function activateEnv(env: string): StoredCredential | undefined {
  const cred = loadCredentialFor(env);
  if (!cred) return undefined;
  // Ensure a per-env copy exists (an older active-only credential wouldn't have
  // one) so the previously-active env stays selectable via `qp use` too.
  if (!readFrom(credentialPathFor(cred.env))) writeTo(credentialPathFor(cred.env), cred);
  writeTo(credentialPath(), cred);
  return cred;
}

/**
 * Log out: remove the active credential AND every per-env copy, so no rqk_live_
 * key is left on disk. Returns true if anything was removed.
 */
export function clearCredential(): boolean {
  let removed = false;
  const active = credentialPath();
  if (existsSync(active)) {
    rmSync(active, { force: true });
    removed = true;
  }
  for (const env of listStoredEnvs()) {
    const p = credentialPathFor(env);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed = true;
    }
  }
  return removed;
}
