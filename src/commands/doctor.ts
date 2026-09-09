/**
 * `reqport doctor` — verify environment wiring, attestation, and key auth.
 *
 * - Resolves --env → base URL.
 * - GET /v1/attestation (unauthenticated) to confirm reachability + TEE
 *   attestation posture.
 * - If a key is present, probes GET /v1/affordances to confirm the key
 *   authenticates and can read.
 */

import { ReqportClient } from "../client.js";
import { maskKey, readApiKey, type ReqportEnv } from "../env.js";
import { explainError, line, printJson } from "../ui.js";

export async function runDoctor(env: ReqportEnv, json: boolean): Promise<number> {
  const key = readApiKey();
  const client = new ReqportClient({ env, apiKey: key });

  const report: Record<string, unknown> = {
    env,
    baseUrl: client.baseUrl,
    apiKey: maskKey(key),
    apiKeyPresent: Boolean(key),
  };

  // 1. Attestation (unauth).
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
  if (key) {
    try {
      const aff = await client.listAffordances({ state: "open" });
      report.auth = { ok: true, openAffordances: aff.total };
    } catch (e) {
      report.auth = { ok: false, detail: explainError(e) };
    }
  } else {
    report.auth = { ok: false, detail: "REQPORT_API_KEY not set." };
  }

  if (json) {
    printJson(report);
  } else {
    line(`Reqport CLI doctor`);
    line(`  env:        ${env}`);
    line(`  base URL:   ${client.baseUrl}`);
    line(`  API key:    ${report.apiKey}`);
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
