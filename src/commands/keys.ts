/**
 * `qp keys ...` — LOCAL credential view + console guidance.
 *
 *   status                 show the active credential's metadata (LOCAL only)
 *   create | list | revoke  → guidance: manage keys in the console
 *
 * Under portal-pairing the CLI holds only an rqk_live_ API key, and Vanta's key-
 * management endpoints (POST/GET/DELETE /v1/orgs/me/api-keys) are HUMAN-only
 * (Signicat JWT + ORG_ADMIN) — an API key cannot call them. So the CLI never
 * calls those endpoints; it points you at the developer console instead.
 */

import { maskKey, readApiKey, type ReqportEnv } from "../env.js";
import { loginSummary } from "../auth/session.js";
import { loadCredential } from "../auth/store.js";
import { DEFAULT_PORTAL_URL, developerConsoleUrl } from "../auth/pairing.js";
import { line, printJson } from "../ui.js";

function consoleUrl(): string {
  const stored = loadCredential();
  const portal = stored?.portalUrl || process.env.QP_PORTAL_URL || DEFAULT_PORTAL_URL;
  const locale = process.env.QP_LOCALE || "en";
  return developerConsoleUrl(portal, locale);
}

/** LOCAL-only: what credential would be used, from env + stored login. No network. */
export function runKeysStatus(env: ReqportEnv, json: boolean): number {
  const key = readApiKey();
  const login = loginSummary();
  const active = key ? "REQPORT_API_KEY (env)" : login.loggedIn ? "stored login" : "none";

  if (json) {
    printJson({
      env,
      apiKeyEnv: maskKey(key),
      apiKeyPresent: Boolean(key),
      login,
      activeCredential: active,
    });
  } else {
    line(`env:             ${env}`);
    line(`REQPORT_API_KEY: ${maskKey(key)}`);
    if (login.loggedIn) {
      line(`stored login:    key id ${login.keyId ?? "(unknown)"} (env ${login.env}), scopes ${(login.scopes as string[]).join(", ") || "(none)"}`);
    } else {
      line(`stored login:    none`);
    }
    line(`active credential: ${active}`);
    line("");
    line(`(Run \`qp doctor\` to check the active credential against the live API.)`);
  }
  return key || login.loggedIn ? 0 : 1;
}

/** create/list/revoke are not CLI operations under pairing — point at the console. */
export function runKeysConsoleGuidance(
  action: "create" | "list" | "revoke",
  json: boolean
): number {
  const url = consoleUrl();
  const msg =
    `Key ${action} is managed in the Reqport developer console (a human, signed in):\n  ${url}\n` +
    `The CLI cannot ${action} keys — Vanta's key-management endpoints require a human login (ORG_ADMIN),\n` +
    `which an API key does not have. To get a key onto this machine, run \`qp login\`.`;
  if (json) {
    printJson({ ok: false, action, reason: "console_only", consoleUrl: url });
  } else {
    line(msg);
  }
  return 0;
}
