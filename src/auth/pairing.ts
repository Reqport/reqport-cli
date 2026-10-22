/**
 * Portal-pairing login flow (the ONLY `qp login` mode) — server-issued device code.
 *
 * Mirrors RFC 8628 (device authorization). No Signicat client, no localhost
 * callback. The CLI:
 *   1. generates a secret PKCE `verifier` and `challenge = b64url(SHA256(verifier))`;
 *   2. POSTs `{challenge, env, name}` to `/api/developer/cli-auth/begin`; the SERVER
 *      answers with an opaque `device_code` (CLI-only poll secret), a short
 *      `user_code` (e.g. ABCD-EFGH), a `verification_uri`, `expires_in`, `interval`;
 *   3. prints the `user_code` and opens `verification_uri?user_code=<user_code>`
 *      (nothing else is put in the URL); the human signs in to the console and
 *      confirms that code;
 *   4. polls `/api/developer/cli-auth/poll` with `{device_code, verifier}` until the
 *      portal relays the minted key (one-time read).
 *
 * Security (reqport-portal #815): the old flow had the CLI choose `state` and the
 * confirmation code was a prefix of it, so an attacker could craft a link and pick
 * the code the victim "confirmed". Now nothing the approver sees or types is chosen
 * by whoever authored a link. An older portal without `/begin` (404) is a hard
 * error; we NEVER fall back to the legacy flow. `device_code`, `verifier` and the
 * API key are never printed or logged.
 */

import { createPkce } from "./pkce.js";
import { openBrowser } from "./openBrowser.js";

/** Canonical prod console. Override with --portal-url / QP_PORTAL_URL for sandbox/aurora. */
export const DEFAULT_PORTAL_URL = "https://reqport.com";

export type PairingResult = {
  apiKey: string;
  keyId?: string;
  env?: string;
  /** Estate-aware display label for the env. */
  envLabel?: string;
  /** The vanta base URL the key was minted against. */
  vantaBaseUrl?: string;
  scopes?: string[];
  expiresAt?: string | null;
};

export type PairingProgress = (msg: string) => void;

export type PairingOptions = {
  portalUrl: string;
  env: string;
  name?: string;
  locale?: string;
  /** Override the overall timeout (default: the server's `expires_in`). */
  timeoutMs?: number;
  /** Override the poll interval (default: the server's `interval`). */
  intervalMs?: number;
};

/** Injectable side effects (tests). */
export type PairingDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  open?: (url: string) => void;
};

/** The developer console URL where keys are managed by a human. */
export function developerConsoleUrl(portalUrl: string, locale = "en"): string {
  return `${portalUrl.replace(/\/$/, "")}/${locale}/developer`;
}

const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const BEGIN_MAX_ATTEMPTS = 4; // 1 try + 3 retries on 429
const BEGIN_BACKOFF_MS = 2_000;
const POLL_BACKOFF_CAP_MS = 30_000;

type BeginResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

export async function runPairing(
  opts: PairingOptions,
  progress: PairingProgress,
  deps: PairingDeps = {}
): Promise<PairingResult> {
  const doFetch = deps.fetch ?? fetch;
  const doSleep = deps.sleep ?? sleep;
  const open = deps.open ?? openBrowser;
  const portalUrl = opts.portalUrl.replace(/\/$/, "");

  const { verifier, challenge } = createPkce(); // challenge = b64url(SHA256(verifier))

  const begin = await beginPairing(doFetch, doSleep, portalUrl, {
    challenge,
    env: opts.env,
    name: opts.name,
  });

  const verifyUrl = buildVerificationUrl(begin.verification_uri, begin.user_code);
  progress(
    `Confirm this code in your browser: ${begin.user_code}\n` +
      `Opening the Reqport console to authorize this CLI:\n  ${verifyUrl}\n` +
      `Check that the page shows the same code, then approve. (Ctrl+C to cancel.)`
  );
  open(verifyUrl);

  const intervalMs = opts.intervalMs ?? Math.max(1, begin.interval) * 1000;
  const timeoutMs = opts.timeoutMs ?? begin.expires_in * 1000;
  const pollUrl = `${portalUrl}/api/developer/cli-auth/poll`;
  const deadline = Date.now() + timeoutMs;

  // Clean Ctrl+C: reject the wait so the caller can print a tidy message.
  let onSigint: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onSigint = () => reject(new Error("Login cancelled."));
    process.once("SIGINT", onSigint);
  });
  cancelled.catch(() => {}); // no unhandled rejection if SIGINT lands between awaits

  let backoffMs = intervalMs;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `Login timed out after ${Math.round(timeoutMs / 1000)} seconds — no approval received. Run \`qp login\` again.`
        );
      }
      const result = await Promise.race([
        pollOnce(doFetch, pollUrl, begin.device_code, verifier),
        cancelled,
      ]);
      if (result === "pending") {
        backoffMs = intervalMs;
        await Promise.race([doSleep(intervalMs), cancelled]);
        continue;
      }
      if (result === "rate_limited") {
        // Exponential back-off (capped), then keep polling until the deadline.
        backoffMs = Math.min(backoffMs * 2, POLL_BACKOFF_CAP_MS);
        await Promise.race([doSleep(backoffMs), cancelled]);
        continue;
      }
      return result;
    }
  } finally {
    if (onSigint) process.removeListener("SIGINT", onSigint);
  }
}

/** Append ONLY `user_code` to the server-provided verification URI. */
export function buildVerificationUrl(verificationUri: string, userCode: string): string {
  const u = new URL(verificationUri);
  u.searchParams.set("user_code", userCode);
  return u.toString();
}

async function beginPairing(
  doFetch: typeof fetch,
  doSleep: (ms: number) => Promise<void>,
  portalUrl: string,
  body: { challenge: string; env: string; name?: string }
): Promise<BeginResponse> {
  const url = `${portalUrl}/api/developer/cli-auth/begin`;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          challenge: body.challenge,
          env: body.env,
          ...(body.name ? { name: body.name } : {}),
        }),
      });
    } catch (e) {
      throw new Error(`Could not reach the portal at ${portalUrl} (${(e as Error).message}).`);
    }

    if (res.status === 200) {
      const j = (await res.json().catch(() => null)) as Partial<BeginResponse> | null;
      if (
        !j ||
        typeof j.device_code !== "string" ||
        !j.device_code ||
        typeof j.user_code !== "string" ||
        typeof j.verification_uri !== "string" ||
        typeof j.expires_in !== "number" ||
        typeof j.interval !== "number"
      ) {
        throw new Error("The portal returned an unexpected pairing response. Run `qp login` again.");
      }
      if (!USER_CODE_RE.test(j.user_code)) {
        throw new Error("The portal returned a malformed confirmation code. Run `qp login` again.");
      }
      let proto = "";
      try {
        proto = new URL(j.verification_uri).protocol;
      } catch {
        /* invalid URL */
      }
      if (proto !== "https:" && proto !== "http:") {
        throw new Error("The portal returned an invalid verification URL. Run `qp login` again.");
      }
      return j as BeginResponse;
    }
    if (res.status === 404) {
      throw new Error(
        `The portal at ${portalUrl} is too old for this version of qp (it has no device-code pairing endpoint). ` +
          `Ask the portal operator to upgrade it, or use an older qp that matches it. ` +
          `qp will not fall back to the legacy login flow because that flow is insecure.`
      );
    }
    if (res.status === 429) {
      if (attempt >= BEGIN_MAX_ATTEMPTS) {
        throw new Error(
          "The portal is rate-limiting login attempts from this network. Wait a minute and run `qp login` again."
        );
      }
      await doSleep(BEGIN_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 503) {
      throw new Error("The portal is busy and cannot start a pairing right now. Run `qp login` again shortly.");
    }
    if (res.status === 400) {
      const detail = await readError(res);
      throw new Error(`The portal rejected the pairing request${detail ? `: ${detail}` : ""}.`);
    }
    throw new Error(`Could not start pairing: HTTP ${res.status}.`);
  }
}

async function readError(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return j && typeof j.error === "string" ? j.error.slice(0, 200) : "";
}

async function pollOnce(
  doFetch: typeof fetch,
  pollUrl: string,
  deviceCode: string,
  verifier: string
): Promise<PairingResult | "pending" | "rate_limited"> {
  let res: Response;
  try {
    res = await doFetch(pollUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ device_code: deviceCode, verifier }),
    });
  } catch {
    // Transient network hiccup — treat as pending so we retry until the deadline.
    return "pending";
  }

  if (res.status === 202) return "pending";
  if (res.status === 429) return "rate_limited";
  if (res.status >= 500) return "pending"; // transient server error — retry until the deadline

  if (res.status === 200) {
    const body = (await res.json().catch(() => ({}))) as {
      apiKey?: string;
      keyId?: string;
      env?: string;
      envLabel?: string;
      vantaBaseUrl?: string;
      scopes?: string[];
      expiresAt?: string | null;
    };
    if (!body.apiKey) {
      throw new Error("Portal returned 200 but no apiKey — cannot complete login.");
    }
    return {
      apiKey: body.apiKey,
      keyId: body.keyId,
      env: body.env,
      envLabel: body.envLabel,
      vantaBaseUrl: body.vantaBaseUrl,
      scopes: body.scopes,
      expiresAt: body.expiresAt ?? null,
    };
  }

  const j = (await res.json().catch(() => null)) as { status?: unknown; error?: unknown } | null;
  const tag = j && typeof j.status === "string" ? j.status : j && typeof j.error === "string" ? j.error : "";

  if (res.status === 410) {
    if (tag === "cli_update_required") {
      throw new Error(
        "The portal requires a newer qp. Update the Reqport CLI (npm i -g @reqport/cli) and run `qp login` again."
      );
    }
    if (tag === "consumed") {
      throw new Error("This pairing was already used. Run `qp login` again.");
    }
    throw new Error("Pairing session expired. Run `qp login` again.");
  }
  if (res.status === 403) {
    throw new Error("The portal rejected the pairing (verifier mismatch). Run `qp login` again.");
  }
  if (res.status === 400) {
    throw new Error("The portal rejected the pairing request (bad request). Run `qp login` again.");
  }
  if (res.status === 404) {
    throw new Error("The portal no longer knows this pairing (not found). Run `qp login` again.");
  }
  throw new Error(`Pairing poll failed: HTTP ${res.status}.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
