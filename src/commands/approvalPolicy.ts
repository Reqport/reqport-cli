/**
 * `qp approval-policy …` — which response types require human approval before
 * they are sealed + sent (server PR #253).
 *
 *   qp approval-policy get
 *   qp approval-policy set <types>     comma-separated, or the sentinel ALL
 *
 * NOTE (unverified against server): the PUT body shape is assumed to be
 * {"responseTypes": [...]} — confirm against the PR #253 controller.
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { line, printJson } from "../ui.js";
import type { ApprovalPolicy } from "../types.js";

async function clientFor(env: ReqportEnv): Promise<ReqportClient> {
  return new ReqportClient({ env, credential: await requireResponderCredential() });
}

function renderPolicy(policy: ApprovalPolicy): void {
  const types = policy.responseTypes ?? [];
  if (types.length === 0) {
    line("Approval policy: no response types require approval (responses are sealed + sent immediately).");
    return;
  }
  if (types.length === 1 && types[0] === "ALL") {
    line("Approval policy: ALL response types require approval before send.");
    return;
  }
  line("Approval policy — response types that require approval before send:");
  for (const t of types) line(`  - ${t}`);
}

export async function runApprovalPolicyGet(
  env: ReqportEnv,
  opts: { json?: boolean }
): Promise<number> {
  const client = await clientFor(env);
  const policy = await client.getApprovalPolicy();

  if (opts.json) {
    printJson(policy);
    return 0;
  }
  renderPolicy(policy);
  return 0;
}

export async function runApprovalPolicySet(
  env: ReqportEnv,
  types: string,
  opts: { json?: boolean }
): Promise<number> {
  // Parse the comma-separated list; upper-case + de-dupe. The sentinel ALL means
  // every response type and is passed through verbatim.
  const parsed: string[] = [];
  const seen = new Set<string>();
  for (const part of types.split(",")) {
    const v = part.trim().toUpperCase();
    if (v === "") continue;
    if (!seen.has(v)) {
      seen.add(v);
      parsed.push(v);
    }
  }
  if (parsed.length === 0) {
    throw new Error(
      "Pass at least one response type (comma-separated), or the sentinel ALL. " +
        "Pass an empty policy is not supported here — use ALL for everything."
    );
  }
  // ALL is exclusive: if present, it is the whole policy.
  const responseTypes = parsed.includes("ALL") ? ["ALL"] : parsed;

  const client = await clientFor(env);
  const policy = await client.setApprovalPolicy(responseTypes);

  if (opts.json) {
    printJson(policy);
    return 0;
  }
  line("Approval policy updated.");
  renderPolicy(policy ?? { responseTypes });
  return 0;
}
