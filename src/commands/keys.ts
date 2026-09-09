/**
 * `reqport keys status` — report the key in use (masked) and confirm it
 * authenticates. Key *management* (create/list/revoke) is HUMAN-only on the
 * Reqport portal /developer page — it cannot be driven by an API key — so this
 * command is read-only.
 */

import { ReqportClient } from "../client.js";
import { maskKey, readApiKey, type ReqportEnv } from "../env.js";
import { explainError, line, printJson } from "../ui.js";

export async function runKeysStatus(env: ReqportEnv, json: boolean): Promise<number> {
  const key = readApiKey();
  const client = new ReqportClient({ env, apiKey: key });
  const report: Record<string, unknown> = {
    env,
    baseUrl: client.baseUrl,
    apiKey: maskKey(key),
    apiKeyPresent: Boolean(key),
    management: "Key management is portal-only (/developer, human login). This CLI never handles a Signicat JWT.",
  };

  if (key) {
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
    line(`API key:  ${report.apiKey}`);
    line(`env:      ${env} (${client.baseUrl})`);
    if (!key) {
      line(`status:   REQPORT_API_KEY not set.`);
    } else if (report.authenticates) {
      line(`status:   authenticates OK (${report.openAffordances} open request(s)).`);
    } else {
      line(`status:   FAILED — ${report.detail}`);
    }
    line(`Manage keys on the Reqport portal /developer page (human login required).`);
  }
  return key && report.authenticates ? 0 : 1;
}
