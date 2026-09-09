/**
 * `qp keys ...` — API-key management.
 *
 *   status                report the credential in use (API key or login)
 *   create --env … …      mint a new rqk_live_ key (requires `qp login` + ORG_ADMIN)
 *   list --env …          list the org's keys (metadata only)
 *   revoke <keyId> --env … revoke a key
 *
 * Minting/listing/revoking require a HUMAN Signicat JWT with ORG_ADMIN — an API
 * key cannot manage keys (enforced by Vanta). Get one with `qp login`.
 */

import { ReqportClient } from "../client.js";
import { maskKey, readApiKey, type ReqportEnv } from "../env.js";
import {
  loginSummary,
  requireJwtCredential,
  resolveResponderCredential,
} from "../auth/session.js";
import { explainError, line, printJson, table } from "../ui.js";

export async function runKeysStatus(env: ReqportEnv, json: boolean): Promise<number> {
  const key = readApiKey();
  const login = loginSummary();
  const cred = await resolveResponderCredential();
  const client = new ReqportClient({ env, credential: cred });

  const report: Record<string, unknown> = {
    env,
    baseUrl: client.baseUrl,
    apiKeyEnv: maskKey(key),
    apiKeyPresent: Boolean(key),
    login,
    activeCredential: cred?.kind ?? "none",
  };

  if (cred) {
    try {
      const aff = await client.listAffordances({ state: "open" });
      report.authenticates = true;
      report.openAffordances = aff.total;
    } catch (e) {
      report.authenticates = false;
      report.detail = explainError(e);
    }
  }

  if (json) {
    printJson(report);
  } else {
    line(`env:            ${env} (${client.baseUrl})`);
    line(`REQPORT_API_KEY: ${report.apiKeyEnv}`);
    line(`login:          ${login.loggedIn ? `${login.clientId} @ ${login.issuer}` : "not logged in"}`);
    line(`active cred:    ${report.activeCredential}`);
    if (!cred) {
      line(`status:         no credential — set REQPORT_API_KEY or run \`qp login\`.`);
    } else if (report.authenticates) {
      line(`status:         authenticates OK (${report.openAffordances} open request(s)).`);
    } else {
      line(`status:         FAILED — ${report.detail}`);
    }
  }
  return cred && report.authenticates ? 0 : 1;
}

export async function runKeysCreate(
  env: ReqportEnv,
  opts: { name?: string; scopes?: string; expiresInDays?: number; json?: boolean }
): Promise<number> {
  if (!opts.name || opts.name.trim() === "") {
    throw new Error("--name is required (a display name for the key).");
  }
  const scopes = (opts.scopes ?? "payloads:read,responses:write")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const cred = await requireJwtCredential();
  const client = new ReqportClient({ env, credential: cred });
  const created = await client.createApiKey({
    displayName: opts.name.trim(),
    scopes,
    expiresInDays: opts.expiresInDays,
  });

  if (opts.json) {
    printJson(created);
  } else {
    line("");
    line(`Created key "${created.displayName}" (${created.keyId}) on ${env}.`);
    line(`  scopes:  ${(created.scopes ?? scopes).join(", ")}`);
    if (created.expiresAt) line(`  expires: ${created.expiresAt}`);
    line("");
    line("Cleartext key (shown ONCE — store it now, it cannot be retrieved again):");
    line("");
    line(`  ${created.apiKey}`);
    line("");
    line("Use it:  export REQPORT_API_KEY=\"" + "<the key above>" + "\"");
  }
  return 0;
}

export async function runKeysList(env: ReqportEnv, json: boolean): Promise<number> {
  const cred = await requireJwtCredential();
  const client = new ReqportClient({ env, credential: cred });
  const keys = await client.listApiKeys();

  if (json) {
    printJson(keys);
    return 0;
  }
  if (keys.length === 0) {
    line(`No API keys on ${env}.`);
    return 0;
  }
  const rows = keys.map((k) => [
    k.keyId,
    k.displayName,
    (k.scopes ?? []).join(" "),
    k.revokedAt ? "revoked" : "active",
    k.expiresAt ?? "",
  ]);
  line(table(["KEY ID", "NAME", "SCOPES", "STATUS", "EXPIRES"], rows));
  return 0;
}

export async function runKeysRevoke(
  env: ReqportEnv,
  keyId: string,
  json: boolean
): Promise<number> {
  const cred = await requireJwtCredential();
  const client = new ReqportClient({ env, credential: cred });
  await client.revokeApiKey(keyId);
  if (json) printJson({ ok: true, revoked: keyId });
  else line(`Revoked key ${keyId} on ${env}.`);
  return 0;
}
