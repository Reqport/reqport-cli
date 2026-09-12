/**
 * `qp login` / `qp logout` / `qp whoami` / `qp use` — portal-pairing auth + the
 * active-env switch.
 *
 * `qp login` opens the Reqport console's CLI-auth page (which reuses the portal's
 * existing Signicat session — no new OAuth client, no device flow, no localhost
 * callback), the human approves, and the portal mints + relays an rqk_live_ key
 * back to the CLI. The key is stored as the active credential (and as a per-env
 * copy). `qp use <env>` switches which stored credential is active.
 */

import type { ReqportEnv } from "../env.js";
import { isReqportEnv, maskKey } from "../env.js";
import { isLoggedIn, logout, loginSummary } from "../auth/session.js";
import { DEFAULT_PORTAL_URL, runPairing } from "../auth/pairing.js";
import { activateEnv, listStoredEnvs, saveCredential } from "../auth/store.js";
import { err, line, printJson } from "../ui.js";

function resolvePortalUrl(flag?: string): string {
  const v = flag || process.env.QP_PORTAL_URL || DEFAULT_PORTAL_URL;
  return v.replace(/\/$/, "");
}

export async function runLogin(opts: {
  env: ReqportEnv;
  portalUrl?: string;
  name?: string;
  json?: boolean;
}): Promise<number> {
  const portalUrl = resolvePortalUrl(opts.portalUrl);
  const locale = process.env.QP_LOCALE || "en";

  const progress = (m: string) => err(m); // → stderr so --json stdout stays clean
  const result = await runPairing(
    { portalUrl, env: opts.env, name: opts.name, locale },
    progress
  );

  const env = (result.env as ReqportEnv) ?? opts.env;
  saveCredential({
    value: result.apiKey,
    kind: "apikey",
    env,
    keyId: result.keyId,
    scopes: result.scopes,
    expiresAt: result.expiresAt ?? null,
    portalUrl,
    savedAt: Date.now(),
  });

  if (opts.json) {
    printJson({
      ok: true,
      env,
      keyId: result.keyId ?? null,
      scopes: result.scopes ?? [],
      expiresAt: result.expiresAt ?? null,
      apiKey: maskKey(result.apiKey),
    });
  } else {
    line("");
    line(`Paired with ${portalUrl} — key stored as the active credential.`);
    line(`  env:     ${env}`);
    if (result.keyId) line(`  key id:  ${result.keyId}`);
    if (result.scopes?.length) line(`  scopes:  ${result.scopes.join(", ")}`);
    if (result.expiresAt) line(`  expires: ${result.expiresAt}`);
    line(`  key:     ${maskKey(result.apiKey)}`);
    line("");
    line(`Active env is now ${env}. Try it:  qp doctor`);
  }
  return 0;
}

export function runLogout(json: boolean): number {
  const cleared = logout();
  if (json) printJson({ ok: true, cleared });
  else line(cleared ? "Logged out (stored key cleared)." : "No stored login to clear.");
  return 0;
}

export function runWhoami(json: boolean): number {
  const summary = loginSummary();
  if (json) {
    printJson(summary);
  } else if (!isLoggedIn()) {
    line("Not logged in. Run `qp login` (or set REQPORT_API_KEY for automation).");
  } else {
    line(`Logged in (paired key)`);
    line(`  env:     ${summary.env}`);
    line(`  key id:  ${summary.keyId ?? "(unknown)"}`);
    line(`  scopes:  ${(summary.scopes as string[]).join(", ") || "(none reported)"}`);
    if (summary.expiresAt) line(`  expires: ${summary.expiresAt}`);
    if (summary.portalUrl) line(`  portal:  ${summary.portalUrl}`);
  }
  return isLoggedIn() ? 0 : 1;
}

/**
 * `qp use [env]` — switch the active env among stored credentials, or (with no
 * arg) print the current active env + key id + login identity.
 */
export function runUse(envArg: string | undefined, json: boolean): number {
  const stored = listStoredEnvs();

  // No arg → report the current active env (same info as whoami, plus the pool).
  if (envArg === undefined || envArg === "") {
    const summary = loginSummary();
    if (json) {
      printJson({ activeEnv: summary.loggedIn ? summary.env : null, storedEnvs: stored, login: summary });
      return summary.loggedIn ? 0 : 1;
    }
    if (!summary.loggedIn) {
      line("No active credential. Run `qp login` (or `qp login --env <env>`).");
      return 1;
    }
    line(`Active env: ${summary.env}`);
    line(`  key id:  ${summary.keyId ?? "(unknown)"}`);
    if (summary.portalUrl) line(`  portal:  ${summary.portalUrl}`);
    line(`  stored:  ${stored.join(", ") || "(none)"}`);
    return 0;
  }

  if (!isReqportEnv(envArg)) {
    err(`Unknown env "${envArg}". Expected one of: sandbox, uat, prod.`);
    return 1;
  }

  const cred = activateEnv(envArg);
  if (!cred) {
    if (json) {
      printJson({ ok: false, env: envArg, reason: "no_credential", storedEnvs: stored });
    } else {
      line(`No stored credential for "${envArg}". Run \`qp login --env ${envArg}\` first.`);
      if (stored.length) line(`  stored envs: ${stored.join(", ")}`);
    }
    return 1;
  }

  if (json) {
    printJson({ ok: true, activeEnv: cred.env, keyId: cred.keyId ?? null, scopes: cred.scopes ?? [] });
  } else {
    line(`Active env is now ${cred.env}.`);
    line(`  key id:  ${cred.keyId ?? "(unknown)"}`);
    line(`  scopes:  ${(cred.scopes ?? []).join(", ") || "(none reported)"}`);
  }
  return 0;
}
