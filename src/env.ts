/**
 * Environment / base-URL resolution and API-key reading.
 *
 * The CLI targets Reqport's Vanta API, which serves every responder endpoint
 * under a `/vanta` origin prefix. Auth is a machine-to-machine API key
 * (`rqk_live_...`) read from the REQPORT_API_KEY environment variable at
 * runtime only. The CLI NEVER accepts a key as a flag and NEVER logs it.
 */

import { activeEnv, loadCredential, loadCredentialFor } from "./auth/store.js";

export type ReqportEnv = "sandbox" | "uat" | "prod" | "dev-uat-sandbox";

const BASE_URLS: Record<ReqportEnv, string> = {
  sandbox: "https://sandbox.reqport.com/vanta",
  uat: "https://vanta.dev-uat.reqport.com/vanta",
  prod: "https://vanta.reqport.com/vanta",
  // The dev-uat-sandbox twin — a canonical fallback for a manual --env /
  // REQPORT_ENV selection. A stored credential's own baseUrl (set at pairing)
  // still wins over this static map; see resolveBaseUrl.
  "dev-uat-sandbox": "https://dev-uat-sandbox.reqport.com/vanta",
};

/** The known static environments, in display order (az-cli-style `qp env` list). */
export const KNOWN_ENVS: readonly ReqportEnv[] = [
  "sandbox",
  "uat",
  "prod",
  "dev-uat-sandbox",
];

export function isReqportEnv(v: string | undefined): v is ReqportEnv {
  return (
    v === "sandbox" || v === "uat" || v === "prod" || v === "dev-uat-sandbox"
  );
}

/**
 * Resolve the target environment. Precedence:
 *   1. explicit --env flag,
 *   2. REQPORT_ENV,
 *   3. the active stored credential's env (set by `qp login` / `qp use`),
 *   4. the default (sandbox — the only public responder sandbox).
 * So after `qp login` (which stores an env), commands need no --env; the flag
 * and REQPORT_ENV still override for one-off cross-env calls.
 */
export function resolveEnv(flag?: string): ReqportEnv {
  const explicit = flag ?? process.env.REQPORT_ENV;
  if (explicit !== undefined && explicit !== "") {
    if (!isReqportEnv(explicit)) {
      throw new Error(
        `Unknown --env "${explicit}". Expected one of: ${KNOWN_ENVS.join(", ")}.`
      );
    }
    return explicit;
  }
  const stored = activeEnv();
  if (stored !== undefined && isReqportEnv(stored)) return stored;
  return "sandbox";
}

export function baseUrlFor(env: ReqportEnv): string {
  // Escape hatch for non-standard stacks (e.g. the dev-uat-sandbox twin at
  // https://dev-uat-sandbox.reqport.com/vanta, which is not one of the three
  // canonical envs). When REQPORT_BASE_URL is set it wins over the env→URL map,
  // so `REQPORT_BASE_URL=… qp requests list` targets that vanta directly. The
  // API key must be one minted by THAT vanta (keys are env-local).
  const override = process.env.REQPORT_BASE_URL;
  if (override && override.trim() !== "") {
    return override.trim().replace(/\/$/, "");
  }
  return BASE_URLS[env];
}

/** Normalise a base URL: trim + drop a trailing slash. */
function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/$/, "");
}

/**
 * The base URL a STORED credential targets. A credential minted after the
 * pairing-response change knows its own vanta URL (`baseUrl`), so we never have
 * to guess it from the static map. Older credentials (no `baseUrl`) fall back to
 * the static env→URL map when their env is canonical, else "(unknown)".
 */
export function credentialBaseUrl(cred: {
  env: string;
  baseUrl?: string;
}): string {
  if (cred.baseUrl && cred.baseUrl.trim() !== "") {
    return normalizeBaseUrl(cred.baseUrl);
  }
  if (isReqportEnv(cred.env)) return BASE_URLS[cred.env];
  return "(unknown)";
}

/**
 * Resolve the target vanta base URL. Precedence:
 *   1. REQPORT_BASE_URL — the explicit per-invocation override (escape hatch),
 *   2. the ACTIVE (or --env / REQPORT_ENV-selected) stored credential's own
 *      `baseUrl` — the URL the key was actually minted against,
 *   3. baseUrlFor(resolveEnv(flag)) — the static env→URL map (now including
 *      dev-uat-sandbox).
 *
 * The KEY PRINCIPLE: a stored credential knows its own vanta URL, so a command
 * targets the exact env its key was minted for without any hardcoded guess.
 */
export function resolveBaseUrl(flag?: string): string {
  const override = process.env.REQPORT_BASE_URL;
  if (override && override.trim() !== "") return normalizeBaseUrl(override);

  // Which stored credential governs this call? A --env flag / REQPORT_ENV picks
  // the per-env credential; otherwise the active credential does.
  const explicit = flag ?? process.env.REQPORT_ENV;
  const cred =
    explicit !== undefined && explicit !== ""
      ? loadCredentialFor(explicit)
      : loadCredential();
  if (cred?.baseUrl && cred.baseUrl.trim() !== "") {
    return normalizeBaseUrl(cred.baseUrl);
  }

  return baseUrlFor(resolveEnv(flag));
}

/**
 * Read the API key from REQPORT_API_KEY. Returns undefined when unset so
 * callers can render a friendly message (unauthenticated commands like
 * `doctor`'s attestation probe still work without it).
 */
export function readApiKey(): string | undefined {
  const key = process.env.REQPORT_API_KEY;
  return key && key.trim() !== "" ? key.trim() : undefined;
}

/** Require the API key, throwing a friendly error when absent. */
export function requireApiKey(): string {
  const key = readApiKey();
  if (!key) {
    throw new Error(
      "REQPORT_API_KEY is not set. Export your rqk_live_ key first:\n" +
        '  export REQPORT_API_KEY="rqk_live_..."   (PowerShell: $env:REQPORT_API_KEY="rqk_live_...")\n' +
        "Create/manage keys on the Reqport portal /developer page."
    );
  }
  return key;
}

/**
 * Mask a key for display — never print the secret. Shows the prefix and a
 * short tail so a human can recognise which key is in use.
 */
export function maskKey(key: string | undefined): string {
  if (!key) return "(not set)";
  if (key.length <= 12) return "rqk_live_****";
  const head = key.slice(0, 12);
  const tail = key.slice(-4);
  return `${head}…${tail}`;
}
