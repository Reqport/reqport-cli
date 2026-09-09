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
  loopback?: boolean;
  issuer?: string;
  clientId?: string;
  scope?: string;
  acr?: string;
  json?: boolean;
}): Promise<number> {
  const cfg = resolveOidcConfig({
    issuer: opts.issuer,
    clientId: opts.clientId,
    scope: opts.scope,
    acr: opts.acr,
  });
  if (!cfg.clientId) {
    const msg =
      "No OAuth client_id configured. Set QP_OAUTH_CLIENT_ID (or pass --client-id).\n" +
      "A PUBLIC, no-callback DEVICE-FLOW `qp` client must be registered in the authority tenant\n" +
      "login.reqport.com/auth/open: client type=public, token_endpoint_auth_method=none,\n" +
      "grants=device_code+refresh_token, PKCE S256, NO redirect URIs, scopes=openid profile email\n" +
      "offline_access, acr_values=idp:otp-email.\n" +
      "See the 'Signicat client registration' section of the README for the full spec.";
    if (opts.json) printJson({ ok: false, reason: "no_client_id", issuer: cfg.issuer });
    else err(msg);
    return 1;
  }

  const progress = (m: string) => err(m); // progress → stderr so --json stdout stays clean
  const result = await performLogin(
    { loopback: opts.loopback, issuer: opts.issuer, clientId: opts.clientId, scope: opts.scope, acr: opts.acr },
    progress
  );

  if (opts.json) {
    printJson({ ok: true, ...result });
  } else {
    line("");
    line(`Logged in to ${result.issuer} (${result.mode} flow)`);
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
