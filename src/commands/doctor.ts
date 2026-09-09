/**
 * `qp doctor` — verify environment wiring, attestation, and credential auth.
 *
 * - Resolves --env → base URL.
 * - GET /v1/attestation to confirm reachability + TEE attestation posture.
 * - Resolves the active credential (REQPORT_API_KEY, else a `qp login` JWT) and
 *   probes GET /v1/affordances to confirm it authenticates.
 */

import { ReqportClient } from "../client.js";
import { maskKey, readApiKey, type ReqportEnv } from "../env.js";
import { loginSummary, resolveResponderCredential } from "../auth/session.js";
import { explainError, line, printJson } from "../ui.js";

export async function runDoctor(env: ReqportEnv, json: boolean): Promise<number> {
  const key = readApiKey();
  const cred = await resolveResponderCredential();
  const client = new ReqportClient({ env, credential: cred });
  const login = loginSummary();

  const report: Record<string, unknown> = {
    env,
    baseUrl: client.baseUrl,
    apiKeyEnv: maskKey(key),
    apiKeyPresent: Boolean(key),
    login,
    activeCredential: cred?.kind ?? "none",
  };

  // 1. Attestation.
  try {
    const att = await client.attestation();
    report.attestation = {
      ok: true,
      hasToken: Boolean(att.maaToken || att.token),
      thumbprint: att.vantaPublicKeyThumbprint ?? null,
    };
  } catch (e) {
    report.attestation = { ok: false, detail: explainError(e) };
  }

  // 2. Authenticated read probe.
  if (cred) {
    try {
      const aff = await client.listAffordances({ state: "open" });
      report.auth = { ok: true, openAffordances: aff.total };
    } catch (e) {
      report.auth = { ok: false, detail: explainError(e) };
    }
  } else {
    report.auth = { ok: false, detail: "No credential — set REQPORT_API_KEY or run `qp login`." };
  }

  if (json) {
    printJson(report);
  } else {
    line(`qp doctor`);
    line(`  env:         ${env}`);
    line(`  base URL:    ${client.baseUrl}`);
    line(`  API key:     ${report.apiKeyEnv}`);
    line(`  login:       ${login.loggedIn ? `${login.clientId} @ ${login.issuer}` : "not logged in"}`);
    line(`  active cred: ${report.activeCredential}`);
    const att = report.attestation as { ok: boolean; hasToken?: boolean; detail?: string };
    line(
      `  attestation: ${att.ok ? `OK${att.hasToken ? " (TEE token present)" : " (no token — dev/alpha env)"}` : `FAILED — ${att.detail}`}`
    );
    const auth = report.auth as { ok: boolean; openAffordances?: number; detail?: string };
    line(
      `  auth probe:  ${auth.ok ? `OK (${auth.openAffordances} open request(s) addressed to you)` : `FAILED — ${auth.detail}`}`
    );
  }

  const attOk = (report.attestation as { ok: boolean }).ok;
  const authOk = (report.auth as { ok: boolean }).ok;
  return attOk && authOk ? 0 : 1;
}
