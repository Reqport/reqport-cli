/**
 * Staff credential storage for `qp login --staff` (Signicat staff flow).
 * Holds the Signicat access token the portal brokered, plus local-only
 * metadata. Files are written 0600 (best-effort on Windows). The access
 * token is NEVER logged.
 *
 * File naming: `staff-credential.${env}.json` in the same config dir as
 * regular credentials. There is no "active" staff credential file (unlike
 * regular credentials); the env is always explicit or falls back to the
 * active regular env.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.js";
import { activeEnv } from "./store.js";

export type StaffCredential = {
  accessToken: string;
  idToken: string;
  email: string;
  expiresAt: string | null; // ISO8601
  env: string;
  portalUrl: string;
  savedAt: number; // Date.now()
};

function staffCredentialPath(env: string): string {
  const safe = env.replace(/[^a-z0-9_-]/gi, "");
  return join(configDir(), `staff-credential.${safe}.json`);
}

function resolveActiveEnv(env?: string): string {
  if (env) return env;
  const fromEnvVar = process.env.REQPORT_ENV;
  if (fromEnvVar && fromEnvVar.trim() !== "") return fromEnvVar.trim();
  return activeEnv() ?? "sandbox";
}

function readStaff(p: string): StaffCredential | null {
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as StaffCredential;
    if (!parsed.accessToken || !parsed.env) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStaff(p: string, c: StaffCredential): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows ACLs — best effort. */
  }
}

export function saveStaffCredential(cred: StaffCredential): void {
  writeStaff(staffCredentialPath(cred.env), cred);
}

export function loadStaffCredential(env?: string): StaffCredential | null {
  const resolved = resolveActiveEnv(env);
  return readStaff(staffCredentialPath(resolved));
}

export function clearStaffCredential(env?: string): boolean {
  const resolved = resolveActiveEnv(env);
  const p = staffCredentialPath(resolved);
  if (existsSync(p)) {
    rmSync(p, { force: true });
    return true;
  }
  return false;
}

/** Returns true if expiresAt is set and the token has already expired. */
export function isStaffCredentialExpired(cred: StaffCredential): boolean {
  if (!cred.expiresAt) return false;
  return Date.now() > new Date(cred.expiresAt).getTime();
}
