/** Shared test helpers: an isolated QP_CONFIG_DIR + credential-file writers. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredCredential } from "../src/auth/store.js";

/** Make a fresh temp config dir and point QP_CONFIG_DIR at it. */
export function freshConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qp-test-"));
  process.env.QP_CONFIG_DIR = dir;
  return dir;
}

export function cleanupConfigDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.QP_CONFIG_DIR;
}

/** Clear the env knobs that influence resolution, so each test starts clean. */
export function clearEnvKnobs(): void {
  delete process.env.REQPORT_BASE_URL;
  delete process.env.REQPORT_ENV;
  delete process.env.REQPORT_API_KEY;
}

export function makeCred(over: Partial<StoredCredential> = {}): StoredCredential {
  return {
    value: "rqk_live_testkey1234567890abcd",
    kind: "apikey",
    env: "prod",
    savedAt: 1_758_200_000_000,
    ...over,
  };
}

/** Write a per-env credential file directly into the config dir. */
export function writePerEnvCred(dir: string, cred: StoredCredential): void {
  writeFileSync(join(dir, `credential.${cred.env}.json`), JSON.stringify(cred, null, 2));
}

/** Write the active credential file directly into the config dir. */
export function writeActiveCred(dir: string, cred: StoredCredential): void {
  writeFileSync(join(dir, "credential.json"), JSON.stringify(cred, null, 2));
}
