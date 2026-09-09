/**
 * Environment / base-URL resolution and API-key reading.
 *
 * The CLI targets Reqport's Vanta API, which serves every responder endpoint
 * under a `/vanta` origin prefix. Auth is a machine-to-machine API key
 * (`rqk_live_...`) read from the REQPORT_API_KEY environment variable at
 * runtime only. The CLI NEVER accepts a key as a flag and NEVER logs it.
 */

export type ReqportEnv = "sandbox" | "uat" | "prod";

const BASE_URLS: Record<ReqportEnv, string> = {
  sandbox: "https://sandbox.reqport.com/vanta",
  uat: "https://vanta.dev-uat.reqport.com/vanta",
  prod: "https://vanta.reqport.com/vanta",
};

export function isReqportEnv(v: string | undefined): v is ReqportEnv {
  return v === "sandbox" || v === "uat" || v === "prod";
}

/**
 * Resolve the target environment. Precedence: explicit --env flag, then
 * REQPORT_ENV, then the default (sandbox — the only public responder sandbox).
 */
export function resolveEnv(flag?: string): ReqportEnv {
  const candidate = flag ?? process.env.REQPORT_ENV;
  if (candidate === undefined || candidate === "") return "sandbox";
  if (!isReqportEnv(candidate)) {
    throw new Error(
      `Unknown --env "${candidate}". Expected one of: sandbox, uat, prod.`
    );
  }
  return candidate;
}

export function baseUrlFor(env: ReqportEnv): string {
  return BASE_URLS[env];
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
