/**
 * `qp use <env>` / `qp env` — az-cli-style environment selection over the
 * credentials `qp login` has stored on this machine.
 *
 *   qp use <env>   switch the ACTIVE credential to the stored one for <env>
 *                  (like `az account set --subscription`).
 *   qp env         list every environment — those with a stored credential
 *                  (marked, with base URL + key + scopes) and the known static
 *                  envs you can still `qp login --env <env>` into
 *                  (like `az account list`).
 *
 * The active `credential.json` is the source of truth for the active env; the
 * per-env `credential.<env>.json` copies are the pool `qp use` selects from.
 * A stored credential carries its OWN vanta base URL (set at pairing), so the
 * CLI shows the exact URL a key targets rather than guessing from a static map.
 * The raw API key is NEVER printed — only the (non-secret) key id / a masked key.
 */

import {
  KNOWN_ENVS,
  baseUrlFor,
  credentialBaseUrl,
  isReqportEnv,
  maskKey,
  type ReqportEnv,
} from "../env.js";
import {
  activateEnv,
  activeEnv,
  listStoredCredentials,
  listStoredEnvs,
  resolveStoredSelector,
} from "../auth/store.js";
import { err, line, printJson, table } from "../ui.js";

/**
 * `qp use <selector>` — switch the active env to the stored credential for
 * `<selector>` (matched by env, then by an estate-aware label). Errors clearly
 * when no credential is stored for it.
 */
export function runUse(selector: string, json: boolean): number {
  const env = resolveStoredSelector(selector);
  if (!env) {
    const stored = listStoredEnvs();
    if (json) {
      printJson({ ok: false, selector, reason: "no_credential", storedEnvs: stored });
    } else {
      err(`No stored credential for "${selector}". Run \`qp login --env ${selector}\` first.`);
      if (stored.length) line(`Stored envs: ${stored.join(", ")}`);
      else line("No environments are logged in yet. Run `qp login`.");
    }
    return 1;
  }

  // resolveStoredSelector guarantees a stored credential exists for `env`.
  const cred = activateEnv(env)!;
  const baseUrl = credentialBaseUrl(cred);

  if (json) {
    printJson({
      ok: true,
      activeEnv: cred.env,
      label: cred.label ?? null,
      baseUrl,
      keyId: cred.keyId ?? null,
      scopes: cred.scopes ?? [],
      apiKey: maskKey(cred.value),
    });
  } else {
    line(`Active env is now ${cred.env}${cred.label ? ` (${cred.label})` : ""}.`);
    line(`  base URL: ${baseUrl}`);
    line(`  key:      ${maskKey(cred.value)}${cred.keyId ? ` (id ${cred.keyId})` : ""}`);
    line(`  scopes:   ${(cred.scopes ?? []).join(", ") || "(none reported)"}`);
  }
  return 0;
}

/**
 * `qp env` — list every environment. Stored credentials are shown with their
 * base URL, key, and scopes (the ACTIVE one marked `*`); known static envs with
 * no stored credential are listed as `login to use` so you see what's available.
 */
export function runEnv(json: boolean): number {
  const active = activeEnv();
  const stored = listStoredCredentials();
  const storedByEnv = new Map(stored.map((c) => [c.env, c]));

  // Display order: the known static envs first, then any extra stored env
  // (e.g. an estate keyed by a non-canonical name) not already covered.
  const envs: string[] = [...KNOWN_ENVS];
  for (const c of stored) if (!envs.includes(c.env)) envs.push(c.env);

  if (json) {
    printJson({
      activeEnv: active ?? null,
      environments: envs.map((env) => {
        const cred = storedByEnv.get(env);
        return {
          env,
          label: cred?.label ?? null,
          baseUrl: cred
            ? credentialBaseUrl(cred)
            : isReqportEnv(env)
              ? baseUrlFor(env as ReqportEnv)
              : null,
          loggedIn: Boolean(cred),
          active: env === active,
          keyId: cred?.keyId ?? null,
          scopes: cred?.scopes ?? [],
          apiKey: cred ? maskKey(cred.value) : null,
        };
      }),
    });
    return 0;
  }

  const rows = envs.map((env) => {
    const cred = storedByEnv.get(env);
    const marker = env === active ? "*" : "";
    const name = cred?.label ? `${env} (${cred.label})` : env;
    if (!cred) {
      const url = isReqportEnv(env) ? baseUrlFor(env as ReqportEnv) : "(unknown)";
      return [marker, name, url, "(login to use)", ""];
    }
    const key = cred.keyId ?? maskKey(cred.value);
    return [
      marker,
      name,
      credentialBaseUrl(cred),
      key,
      (cred.scopes ?? []).join(", "),
    ];
  });

  line(table([" ", "ENV", "BASE URL", "KEY", "SCOPES"], rows));
  line("");
  if (active) {
    line(`Active env: ${active}. Switch with \`qp use <env>\`.`);
  } else {
    line("No active credential. Run `qp login` (or `qp login --env <env>`).");
  }
  return 0;
}
