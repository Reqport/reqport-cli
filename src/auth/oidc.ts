/**
 * OIDC flows for `qp login`, against the Signicat "open" tenant:
 *   issuer https://login.reqport.com/auth/open
 *
 * - Runtime OIDC discovery (never hardcode endpoints).
 * - Authorization Code + PKCE (S256) with a 127.0.0.1 loopback redirect
 *   (public client — no client secret). The CLI never sees the password.
 * - Device Authorization Grant fallback for headless use.
 * - Refresh-token grant.
 *
 * A dedicated PUBLIC `qp` OAuth client must be registered in Signicat before a
 * real login can succeed (the tenant does not currently allow
 * token_endpoint_auth_method=none). See README for the registration spec.
 */

import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { createPkce, randomState } from "./pkce.js";
import { openBrowser } from "./openBrowser.js";

export const DEFAULT_ISSUER = "https://login.reqport.com/auth/open";
const DEFAULT_SCOPE = "openid profile email offline_access";
/** Mirror the portal's email-OTP login so the UX matches. Overridable. */
const DEFAULT_ACR = "idp:otp-email";

export type OidcConfig = {
  issuer: string;
  clientId: string;
  scope: string;
  /** acr_values (authentication method). Empty string = omit the param. */
  acr: string;
};

export type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  device_authorization_endpoint?: string;
  [k: string]: unknown;
};

export type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
};

export function resolveOidcConfig(overrides?: Partial<OidcConfig>): OidcConfig {
  const issuer = overrides?.issuer || process.env.QP_ISSUER || DEFAULT_ISSUER;
  const clientId = overrides?.clientId || process.env.QP_OAUTH_CLIENT_ID || "";
  const scope = overrides?.scope || process.env.QP_OAUTH_SCOPE || DEFAULT_SCOPE;
  // acr defaults to email-OTP; QP_OAUTH_ACR="" (explicit empty) or --acr "" omits it.
  const acr =
    overrides?.acr !== undefined
      ? overrides.acr
      : process.env.QP_OAUTH_ACR !== undefined
        ? process.env.QP_OAUTH_ACR
        : DEFAULT_ACR;
  return { issuer, clientId, scope, acr };
}

export async function discover(issuer: string): Promise<Discovery> {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(
      `OIDC discovery failed at ${url}: HTTP ${res.status}. Check --issuer / QP_ISSUER.`
    );
  }
  const d = (await res.json()) as Discovery;
  if (!d.authorization_endpoint || !d.token_endpoint) {
    throw new Error(`OIDC discovery at ${url} is missing required endpoints.`);
  }
  return d;
}

async function postForm(endpoint: string, form: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(form).toString();
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
}

function requireClientId(cfg: OidcConfig): void {
  if (!cfg.clientId) {
    throw new Error(
      "No OAuth client_id configured. Set QP_OAUTH_CLIENT_ID (or pass --client-id) to the PUBLIC `qp` client in Signicat.\n" +
        "That client must be registered in the authority tenant login.reqport.com/auth/open as a no-callback device-flow client:\n" +
        "  client type=public, token_endpoint_auth_method=none, grants=device_code+refresh_token, PKCE S256, NO redirect URIs,\n" +
        "  scopes=openid profile email offline_access, acr_values=idp:otp-email.\n" +
        "See the 'Signicat client registration' section of the README for the full spec."
    );
  }
}

// ── Authorization Code + PKCE with loopback (NON-PROD / opt-in `--loopback`) ──
//
// The production authority client has NO redirect URIs, so this loopback path
// only works against a client registered with a 127.0.0.1 callback (local/dev
// use). The default login mode is the device grant below.

export type LoginProgress = (msg: string) => void;

export async function loginAuthCode(
  cfg: OidcConfig,
  disc: Discovery,
  progress: LoginProgress
): Promise<TokenResponse> {
  requireClientId(cfg);
  const pkce = createPkce();
  const state = randomState();

  // Start a loopback server on an ephemeral port BEFORE building the redirect.
  const { redirectUri, waitForCode, close } = await startLoopback(state);

  const authUrl = new URL(disc.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", cfg.scope);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", pkce.method);
  if (cfg.acr) authUrl.searchParams.set("acr_values", cfg.acr);

  progress(`Opening your browser to sign in:\n  ${authUrl.toString()}`);
  openBrowser(authUrl.toString());
  progress("Waiting for the sign-in to complete (Ctrl+C to cancel)…");

  try {
    const code = await waitForCode();
    const res = await postForm(disc.token_endpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      code_verifier: pkce.verifier,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Token exchange failed: HTTP ${res.status} ${text}`);
    }
    return (await res.json()) as TokenResponse;
  } finally {
    close();
  }
}

async function startLoopback(expectedState: string): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => void;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname !== "/callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const err = reqUrl.searchParams.get("error");
    const code = reqUrl.searchParams.get("code");
    const state = reqUrl.searchParams.get("state");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (err) {
      res.statusCode = 400;
      res.end(`<html><body><h3>Sign-in failed: ${escapeHtml(err)}</h3>You can close this tab.</body></html>`);
      rejectCode(new Error(`Authorization error: ${err}`));
      return;
    }
    if (!code || state !== expectedState) {
      res.statusCode = 400;
      res.end(`<html><body><h3>Sign-in failed: invalid state or missing code.</h3>You can close this tab.</body></html>`);
      rejectCode(new Error("Authorization callback had an invalid state or missing code (possible CSRF)."));
      return;
    }
    res.statusCode = 200;
    res.end(`<html><body><h3>Signed in to Reqport.</h3>You can close this tab and return to the terminal.</body></html>`);
    resolveCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    // Port 0 = ephemeral; bind to loopback only.
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Overall timeout so a never-returning browser doesn't hang the CLI forever.
  const timeout = setTimeout(() => rejectCode(new Error("Login timed out after 5 minutes.")), 5 * 60_000);

  return {
    redirectUri,
    waitForCode: () => codePromise,
    close: () => {
      clearTimeout(timeout);
      server.close();
    },
  };
}

// ── Device Authorization Grant (DEFAULT login mode) ───────────────────────────
//
// No redirect URI at all — the user authorizes on a Signicat page (their own
// device). This is the default because the production authority client is
// registered without any callback URL.

export type DeviceAuthResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

export async function loginDeviceCode(
  cfg: OidcConfig,
  disc: Discovery,
  progress: LoginProgress
): Promise<TokenResponse> {
  requireClientId(cfg);
  if (!disc.device_authorization_endpoint) {
    throw new Error(
      "This issuer's discovery document has no device_authorization_endpoint; the tenant must enable the device grant."
    );
  }
  const startForm: Record<string, string> = {
    client_id: cfg.clientId,
    scope: cfg.scope,
  };
  if (cfg.acr) startForm.acr_values = cfg.acr;
  const startRes = await postForm(disc.device_authorization_endpoint, startForm);
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new Error(`Device authorization failed: HTTP ${startRes.status} ${text}`);
  }
  const da = (await startRes.json()) as DeviceAuthResponse;

  progress(
    `To sign in, visit:\n  ${da.verification_uri_complete ?? da.verification_uri}\n` +
      (da.verification_uri_complete ? "" : `and enter the code:  ${da.user_code}\n`) +
      "Waiting for authorization…"
  );

  let interval = (da.interval ?? 5) * 1000;
  const deadline = Date.now() + da.expires_in * 1000;

  for (;;) {
    if (Date.now() > deadline) throw new Error("Device login expired before authorization.");
    await sleep(interval);
    const res = await postForm(disc.token_endpoint, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: da.device_code,
      client_id: cfg.clientId,
    });
    if (res.ok) return (await res.json()) as TokenResponse;
    const errJson = (await res.json().catch(() => ({}))) as { error?: string };
    const err = errJson.error;
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5000;
      continue;
    }
    if (err === "expired_token") throw new Error("Device login expired before authorization.");
    if (err === "access_denied") throw new Error("Sign-in was denied.");
    throw new Error(`Device token poll failed: ${err ?? `HTTP ${res.status}`}`);
  }
}

// ── Refresh ─────────────────────────────────────────────────────────────────

export async function refresh(
  cfg: Pick<OidcConfig, "clientId">,
  tokenEndpoint: string,
  refreshToken: string
): Promise<TokenResponse> {
  const res = await postForm(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}
