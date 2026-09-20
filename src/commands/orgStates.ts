/**
 * `qp org-states <orgId>` — a requestor org's verifiable status from the consortium
 * oracles (GET /v1/orgs/{orgId}/states, scope reference:read). This is what a responder
 * inspects before writing requestor-status rules (see `qp requestor-ruleset`), e.g. to
 * confirm an org is a Swedish law-enforcement authority before auto-approving it.
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { line, printJson } from "../ui.js";
import type { OrgStates } from "../types.js";

function renderStates(s: OrgStates): void {
  line(`Org states — ${s.orgId}`);
  line(`  authority:            ${s.isAuthority ? "yes" : "no"}`);
  line(`  law-enforcement:      ${s.lawEnforcementAgency == null ? "unknown" : s.lawEnforcementAgency ? "yes" : "no"}`);
  line(`  regulated FI:         ${s.isRegulatedFi ? "yes" : "no"}`);
  line(`  regulatory classes:   ${(s.regulatoryClasses ?? []).length ? (s.regulatoryClasses ?? []).join(", ") : "—"}`);
  line(`  country:              ${s.country ?? "—"}`);
  line(`  status:               ${s.status ?? "—"}`);
}

export async function runOrgStates(
  env: ReqportEnv,
  orgId: string,
  opts: { json?: boolean }
): Promise<number> {
  const id = orgId?.trim();
  if (!id) throw new Error("Pass an org id, e.g. qp org-states ORG_POLISEN_SE");
  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  const states = await client.getOrgStates(id);
  if (opts.json) {
    printJson(states);
    return 0;
  }
  renderStates(states);
  return 0;
}
