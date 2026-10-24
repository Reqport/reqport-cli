/**
 * `qp login` / `qp logout` / `qp whoami` — portal-pairing auth.
 *
 * `qp login` opens the Reqport console's CLI-auth page (which reuses the portal's
 * existing Signicat session — no new OAuth client, no device flow, no localhost
 * callback), the human approves, and the portal mints + relays an rqk_live_ key
 * back to the CLI. The key is stored as the active credential (and as a per-env
 * copy). The active-env switch + listing live in `qp use` / `qp env` (use.ts).
 */

import type { ReqportEnv } from "../env.js";
import { credentialBaseUrl, defaultPortalUrlForEnv, maskKey } from "../env.js";
import { isLoggedIn, logout, loginSummary } from "../auth/session.js";
import { runPairing } from "../auth/pairing.js";
import { saveCredential } from "../auth/store.js";
import { saveStaffCredential } from "../auth/staffStore.js";
import { runStaffLogin as _runStaffLogin } from "../auth/staffLogin.js";
import { err, line, printJson } from "../ui.js";

/**
 * Resolve the portal base URL. Precedence:
 *   1. explicit --portal-url flag
 *   2. QP_PORTAL_URL env var
 *   3. the env-specific default (uat/dev-uat-sandbox → dev-uat.reqport.com,
 *      sandbox/prod → reqport.com)
 *
 * Each environment has its own Signicat client baked into its portal
 * deployment, so pointing at the wrong portal causes an "invalid pairing
 * link" error on the cli-auth page.
 */
function resolvePortalUrl(flag: string | undefined, env: ReqportEnv): string {
  const v = flag || process.env.QP_PORTAL_URL || defaultPortalUrlForEnv(env);
  return v.replace(/\/$/, "");
}

export async function runLogin(opts: {
  env: ReqportEnv;
  portalUrl?: string;
  name?: string;
  json?: boolean;
}): Promise<number> {
  const portalUrl = resolvePortalUrl(opts.portalUrl, opts.env);
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
    // Newer portals return the actual minted-against vanta URL + an estate label;
    // persist them so the CLI targets the right vanta without guessing (and be
    // tolerant of older portals that omit them).
    ...(result.vantaBaseUrl ? { baseUrl: result.vantaBaseUrl } : {}),
    ...(result.envLabel ? { label: result.envLabel } : {}),
    keyId: result.keyId,
    scopes: result.scopes,
    expiresAt: result.expiresAt ?? null,
    portalUrl,
    savedAt: Date.now(),
  });

  const baseUrl = credentialBaseUrl({ env, baseUrl: result.vantaBaseUrl });

  if (opts.json) {
    printJson({
      ok: true,
      env,
      envLabel: result.envLabel ?? null,
      baseUrl,
      keyId: result.keyId ?? null,
      scopes: result.scopes ?? [],
      expiresAt: result.expiresAt ?? null,
      apiKey: maskKey(result.apiKey),
    });
  } else {
    line("");
    line(`Paired with ${portalUrl} — key stored as the active credential.`);
    line(`  env:     ${env}${result.envLabel ? ` (${result.envLabel})` : ""}`);
    line(`  base URL: ${baseUrl}`);
    if (result.keyId) line(`  key id:  ${result.keyId}`);
    if (result.scopes?.length) line(`  scopes:  ${result.scopes.join(", ")}`);
    if (result.expiresAt) line(`  expires: ${result.expiresAt}`);
    line(`  key:     ${maskKey(result.apiKey)}`);
    line("");
    line(`Active env is now ${env}. Try it:  qp doctor`);
  }
  return 0;
}

/**
 * `qp login --staff` — Signicat staff login via portal broker.
 *
 * Runs the localhost-callback PKCE flow, exchanges the code for a Signicat
 * access token via the portal, and stores it as a staff credential. The
 * resulting credential is used by `qp authority` commands as a Bearer token
 * on vanta's HUMAN-classified staff endpoints.
 */
export async function runStaffLogin(opts: {
  env: ReqportEnv;
  portalUrl?: string;
  json?: boolean;
}): Promise<number> {
  const portalUrl = resolvePortalUrl(opts.portalUrl, opts.env);
  const progress = (m: string) => err(m); // → stderr so --json stdout stays clean

  const result = await _runStaffLogin({ portalUrl, env: opts.env }, progress);

  saveStaffCredential({
    bearer: result.bearer,
    
    email: result.email,
    expiresAt: result.expiresAt,
    env: opts.env,
    portalUrl,
    savedAt: Date.now(),
  });

  if (opts.json) {
    printJson({
      ok: true,
      env: opts.env,
      email: result.email,
      expiresAt: result.expiresAt,
    });
  } else {
    line("");
    line(`Staff credential stored for env: ${opts.env}`);
    line(`  email:    ${result.email}`);
    line(`  expires:  ${result.expiresAt ?? "(no expiry)"}`);
    line("");
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
    line(`  env:      ${summary.env}${summary.label ? ` (${summary.label})` : ""}`);
    line(`  base URL: ${summary.baseUrl}`);
    line(`  key id:   ${summary.keyId ?? "(unknown)"}`);
    line(`  scopes:   ${(summary.scopes as string[]).join(", ") || "(none reported)"}`);
    if (summary.expiresAt) line(`  expires:  ${summary.expiresAt}`);
    if (summary.portalUrl) line(`  portal:   ${summary.portalUrl}`);
  }
  return isLoggedIn() ? 0 : 1;
}
