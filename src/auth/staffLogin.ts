/**
 * Staff login flow.
 *
 * Unlike the portal-pairing flow (which mints an API key), staff login goes
 * through Signicat via the portal broker:
 *   1. GET /api/developer/staff-auth/authorize → Signicat auth URL
 *   2. Browser → Signicat → redirects to http://127.0.0.1:59500/callback
 *   3. POST /api/developer/staff-auth/exchange → Signicat tokens
 *
 * The resulting accessToken is stored as a staff credential (separate from
 * the API key credential) and used as a Bearer token for staff commands.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import * as rl from "node:readline/promises";
import { createPkce, randomState } from "./pkce.js";
import { openBrowser } from "./openBrowser.js";

export type StaffLoginResult = {
  /** The Signicat access token — used as Bearer on vanta staff endpoints. */
  bearer: string;
  email: string;
  expiresAt: string | null; // ISO8601
};

/** Port registered in Signicat as the CLI callback redirect URI. */
const CALLBACK_PORT = 59500;

type AuthorizeResponse = {
  authUrl: string;
  session: string;
};

type CallbackResult = {
  code: string;
  state: string;
};

/** Start an HTTP server on 127.0.0.1:CALLBACK_PORT and return it. */
async function startCallbackServer(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        reject(new Error("Port 59500 is in use. Free it and retry."));
      } else {
        reject(e);
      }
    });
    server.listen(CALLBACK_PORT, "127.0.0.1", () => resolve(server));
  });
}

/** Prompt for the staff email on stderr (so --json stdout stays clean). */
async function promptEmail(): Promise<string> {
  const iface = rl.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await iface.question("Enter your @reqport.com email: ");
    return answer.trim();
  } finally {
    iface.close();
  }
}

/** GET the authorize endpoint, returning {authUrl, session}. */
async function callAuthorize(
  portalUrl: string,
  challenge: string,
  state: string,
  hint?: string
): Promise<AuthorizeResponse> {
  const params = new URLSearchParams({ challenge, state });
  if (hint) params.set("hint", hint);
  const url = `${portalUrl}/api/developer/staff-auth/authorize?${params.toString()}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Portal returned HTTP ${resp.status} from authorize: ${body}`);
  }
  const data = (await resp.json()) as AuthorizeResponse;
  return data;
}

/** Wait for GET /callback?code=...&state=... on the given server. */
function waitForCallback(server: Server): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const code = reqUrl.searchParams.get("code");
        const callbackState = reqUrl.searchParams.get("state");
        if (!code || !callbackState) {
          res.writeHead(400);
          res.end("Missing code or state");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reqport CLI — signed in</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       background:#0f0f0f;color:#f0f0f0;
       display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;
        padding:40px 48px;text-align:center;max-width:400px;width:90%}
  .check{font-size:48px;margin-bottom:16px}
  h1{font-size:20px;font-weight:600;margin-bottom:8px}
  p{font-size:14px;color:#888;line-height:1.5}
</style>
</head>
<body>
<div class="card">
  <div class="check">✓</div>
  <h1>Signed in</h1>
  <p>You can close this window and return to the terminal.</p>
</div>
</body>
</html>`);
        server.close();
        resolve({ code, state: callbackState });
      } catch (e) {
        res.writeHead(500);
        res.end("Internal error");
        server.close();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

export async function runStaffLogin(
  opts: { portalUrl: string; env: string; timeoutMs?: number; email?: string },
  progress: (msg: string) => void
): Promise<StaffLoginResult> {
  const portalUrl = opts.portalUrl.replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  // Resolve the hint email before opening the server so that if the user
  // cancels the prompt the port is never claimed.
  let hint = opts.email?.trim() || "";
  if (!hint) {
    hint = await promptEmail();
  }

  const { verifier, challenge } = createPkce();
  const state = randomState();

  // 1. Start HTTP callback server before requesting the auth URL.
  const server = await startCallbackServer();

  // 2. GET authorize → {authUrl, session}. Close the server on error so
  //    the port isn't left open if the portal call fails.
  let authorizeResult: AuthorizeResponse;
  try {
    authorizeResult = await callAuthorize(portalUrl, challenge, state, hint || undefined);
  } catch (e) {
    server.close();
    throw e;
  }

  // 3. Open browser and tell the user what's happening.
  openBrowser(authorizeResult.authUrl);
  progress(
    `Opening browser for Signicat authentication...\n` +
      `Waiting for callback on http://127.0.0.1:${CALLBACK_PORT}/callback ...`
  );

  // 4. Wait for the callback with a timeout and clean SIGINT handling.
  // IMPORTANT: both the SIGINT listener and the deadline timer must be torn down
  // after the race resolves — otherwise the pending timer keeps the process alive
  // even after a successful login.
  let onSigint: (() => void) | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelled = new Promise<never>((_, reject) => {
    onSigint = () => {
      server.close();
      reject(new Error("Staff login cancelled."));
    };
    process.once("SIGINT", onSigint);
  });
  const timedOut = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      server.close();
      reject(
        new Error(
          `Staff login timed out after ${Math.round(timeoutMs / 60_000)} minutes. Try again.`
        )
      );
    }, timeoutMs);
  });

  let callbackResult: CallbackResult;
  try {
    callbackResult = await Promise.race([waitForCallback(server), cancelled, timedOut]);
  } finally {
    if (onSigint) process.removeListener("SIGINT", onSigint);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }

  // 5. Verify state to prevent CSRF.
  if (callbackResult.state !== state) {
    throw new Error("State mismatch. Try again.");
  }

  // 6. POST exchange to trade the code for tokens.
  const exchangeResp = await fetch(`${portalUrl}/api/developer/staff-auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      code: callbackResult.code,
      verifier,
      state: callbackResult.state,
      session: authorizeResult.session,
    }),
  });

  if (!exchangeResp.ok) {
    const rawBody = await exchangeResp.text().catch(() => "");
    let detail = rawBody;
    try {
      const parsed = JSON.parse(rawBody) as { error?: string; message?: string };
      detail = parsed.error ?? parsed.message ?? rawBody;
    } catch {
      /* use raw body as-is */
    }
    throw new Error(`Exchange failed: HTTP ${exchangeResp.status}: ${detail}`);
  }

  const tokens = (await exchangeResp.json()) as {
    bearer: string;
    email: string;
    expiresAt?: string | null;
  };

  return {
    bearer: tokens.bearer,
    email: tokens.email,
    expiresAt: tokens.expiresAt ?? null,
  };
}
