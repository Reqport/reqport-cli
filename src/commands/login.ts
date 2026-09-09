/**
 * `qp login` / `qp logout` — human authentication via Signicat.
 *
 * Auth happens entirely in the browser (or on a second device for --device);
 * the CLI never sees the user's password. On success, tokens are stored so
 * `qp keys create` and the responder commands can use the JWT.
 */

import { performLogin, logout, loginSummary } from "../auth/session.js";
import { resolveOidcConfig } from "../auth/oidc.js";
import { err, line, printJson } from "../ui.js";

export async function runLogin(opts: {
  device?: boolean;
  issuer?: string;
  clientId?: string;
  scope?: string;
  json?: boolean;
}): Promise<number> {
  const cfg = resolveOidcConfig({ issuer: opts.issuer, clientId: opts.clientId, scope: opts.scope });
  if (!cfg.clientId) {
    const msg =
      "No OAuth client_id configured. A PUBLIC `qp` client must be registered in Signicat, then set QP_OAUTH_CLIENT_ID (or pass --client-id).\n" +
      "See the 'Signicat client registration' section of the README for the exact spec to hand your Signicat admin.";
    if (opts.json) printJson({ ok: false, reason: "no_client_id", issuer: cfg.issuer });
    else err(msg);
    return 1;
  }

  const progress = (m: string) => err(m); // progress → stderr so --json stdout stays clean
  const result = await performLogin(
    { device: opts.device, issuer: opts.issuer, clientId: opts.clientId, scope: opts.scope },
    progress
  );

  if (opts.json) {
    printJson({ ok: true, ...result });
  } else {
    line("");
    line(`Logged in to ${result.issuer}`);
    line(`  client:  ${result.clientId}`);
    line(`  scopes:  ${result.scope}`);
    line(`  expires: ${new Date(result.expiresAt).toISOString()}`);
    line("");
    line("Now mint a key:  qp keys create --env sandbox --name my-integration --scopes payloads:read,responses:write");
  }
  return 0;
}

export function runLogout(json: boolean): number {
  const cleared = logout();
  if (json) printJson({ ok: true, cleared });
  else line(cleared ? "Logged out (tokens cleared)." : "No stored session to clear.");
  return 0;
}

export function runWhoami(json: boolean): number {
  const summary = loginSummary();
  if (json) printJson(summary);
  else if (!summary.loggedIn) line("Not logged in. Run `qp login`.");
  else {
    line(`Logged in to ${summary.issuer}`);
    line(`  client:  ${summary.clientId}`);
    line(`  scopes:  ${summary.scope}`);
    line(`  expires: ${summary.expiresAt}${summary.expired ? " (EXPIRED — will refresh on next use)" : ""}`);
  }
  return summary.loggedIn ? 0 : 1;
}
