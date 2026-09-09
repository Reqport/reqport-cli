/**
 * `reqport requests list` and `reqport requests show <id>`.
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { isBusinessRelationship, readRequest } from "../core.js";
import { line, printJson, table } from "../ui.js";

export async function runList(
  env: ReqportEnv,
  opts: { state?: string; type?: string; mine?: boolean; json?: boolean }
): Promise<number> {
  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  const res = await client.listAffordances({
    state: opts.state ?? "open",
    edgeType: opts.type,
    mine: opts.mine,
  });

  if (opts.json) {
    printJson(res);
    return 0;
  }

  const rows: string[][] = [];
  for (const group of res.groups ?? []) {
    for (const item of group.items ?? []) {
      rows.push([
        item.workflowInstanceId,
        item.edgeType,
        item.edgeState,
        item.createdAt ?? "",
      ]);
    }
  }
  if (rows.length === 0) {
    line(
      `No ${opts.mine ? "owned" : "addressed"} requests in state "${opts.state ?? "open"}"${opts.type ? ` of type ${opts.type}` : ""}.`
    );
    line(
      `(Sandbox is seeded by the synthetic authority reqport-authority-test.com; if empty, seeding may not have reached your org yet.)`
    );
    return 0;
  }
  line(table(["REQUEST ID", "TYPE", "STATE", "CREATED"], rows));
  line("");
  line(`${res.total} request(s). Read one:  qp requests show <REQUEST ID>`);
  return 0;
}

export async function runShow(
  env: ReqportEnv,
  id: string,
  opts: { json?: boolean }
): Promise<number> {
  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  const detail = await readRequest(client, id);

  if (opts.json) {
    printJson(detail);
    return 0;
  }

  const wf = detail.workflow;
  line(`Request ${wf.workflowInstanceId}`);
  line(`  type:      ${wf.workflowType}`);
  line(`  status:    ${wf.status}${wf.responseOutcome ? ` (${wf.responseOutcome})` : ""}`);
  if (wf.requesterOrgId) line(`  requester: ${wf.requesterOrgId}`);
  if (wf.responderOrgId) line(`  responder: ${wf.responderOrgId}`);
  line(`  you are:   ${wf.callerIsResponder ? "the RESPONDER (you answer this)" : "a party"}`);
  if (wf.relatesToWorkflowInstanceId)
    line(`  relates to: ${wf.relatesToWorkflowInstanceId}`);
  line("");

  if (detail.decoded?.ok) {
    line("Request content (decrypted in the TEE):");
    if (detail.decoded.json !== undefined) {
      line(JSON.stringify(detail.decoded.json, null, 2));
    } else {
      line(detail.decoded.text ?? "");
    }
  } else if (detail.readNote) {
    line(detail.readNote);
  }

  line("");
  if (isBusinessRelationship(wf.workflowType)) {
    line("Answer it:");
    line(`  qp respond ${id} --has-relationship false          # no such customer (auth.002 NFOU)`);
    line(`  qp respond ${id} --has-relationship true --account ACCOUNT:SE1234567890:IBAN:Main`);
  } else {
    line("Answer it:");
    line(`  qp respond ${id} --status NFOU`);
    line(`  qp respond ${id} --status COMP --free-text "…"`);
  }
  return 0;
}
