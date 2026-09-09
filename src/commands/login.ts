/**
 * `qp login` / `qp logout` / `qp whoami` — portal-pairing authentication.
 *
 * `qp login` opens the Reqport console's CLI-auth page (which reuses the portal's
 * existing Signicat session — no new OAuth client, no device flow, no localhost
 * callback), the human approves, and the portal mints + relays an rqk_live_ key
 * back to the CLI. The key is stored as the active credential.
 */

import type { ReqportEnv } from "../env.js";
import { maskKey } from "../env.js";
import { isLoggedIn, logout, loginSummary } from "../auth/session.js";
import { DEFAULT_PORTAL_URL, runPairing } from "../auth/pairing.js";
import { saveCredential } from "../auth/store.js";
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
    line(`Try it:  qp --env ${env} doctor`);
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
