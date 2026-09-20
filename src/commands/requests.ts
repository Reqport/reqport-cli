/**
 * `reqport requests list` and `reqport requests show <id>`.
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { isBusinessRelationship, isTransactionHistory, readRequest } from "../core.js";
import { line, printJson, table } from "../ui.js";
import type {
  DirectInformationRequest,
  DirectKycRequest,
  DirectTransactionHistoryRequest,
} from "../types.js";

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

/** One of --responder-org / --responder is required. Returns the locator pair. */
function responderLocator(opts: {
  responder?: string;
  responderOrg?: string;
}): { responderDomain?: string; responderOrgId?: string } {
  if (opts.responder && opts.responderOrg) {
    throw new Error("provide only one of --responder (domain) or --responder-org (org id).");
  }
  if (!opts.responder && !opts.responderOrg) {
    throw new Error("a responder is required: --responder <domain> or --responder-org <orgId>.");
  }
  return opts.responder
    ? { responderDomain: opts.responder }
    : { responderOrgId: opts.responderOrg };
}

/**
 * `qp requests create tx-history` — an identifier-first transaction-history
 * request: the authority already holds the wallet and asks a known-holder
 * responder directly, with no preceding business-relationship check.
 */
export async function runCreateTxHistory(
  env: ReqportEnv,
  opts: {
    responder?: string;
    responderOrg?: string;
    wallet?: string;
    scheme?: string;
    instrumentType?: string;
    from?: string;
    to?: string;
    case?: string;
    legalBasis?: string;
    message?: string;
    personnummer?: string;
    orgnr?: string;
    json?: boolean;
  }
): Promise<number> {
  if (!opts.wallet) throw new Error("--wallet <identifier> is required (the wallet/account you already hold).");
  if (!opts.from || !opts.to) throw new Error("--from and --to (yyyy-mm-dd) are required.");
  if (!opts.case) throw new Error("--case <invstgtnId> is required.");
  if (!opts.legalBasis) throw new Error("--legal-basis <mandate> is required.");

  const body: DirectTransactionHistoryRequest = {
    ...responderLocator(opts),
    instrumentType: opts.instrumentType,
    identifier: opts.wallet,
    scheme: opts.scheme,
    from: opts.from,
    to: opts.to,
    invstgtnId: opts.case,
    legalBasis: opts.legalBasis,
    message: opts.message,
    subjectPersonnummer: opts.personnummer,
    subjectOrgNr: opts.orgnr,
  };

  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  const res = await client.createDirectTransactionHistory(body);
  if (opts.json) {
    printJson(res);
    return 0;
  }
  line(`Created transaction-history request ${res.requestId}`);
  line(`  type:      ${res.workflowType ?? "TRANSACTION_HISTORY_CHECK_V1"}`);
  if (res.status) line(`  status:    ${res.status}`);
  if (res.responderOrgId) line(`  responder: ${res.responderOrgId}`);
  line("");
  line(`Track it:  qp requests show ${res.requestId}`);
  return 0;
}

/**
 * `qp requests create kyc` — an identifier-first KYC/CDD request on a subject,
 * addressed directly to a known-holder responder, with no preceding BR check.
 */
export async function runCreateKyc(
  env: ReqportEnv,
  opts: {
    responder?: string;
    responderOrg?: string;
    personnummer?: string;
    orgnr?: string;
    case?: string;
    legalBasis?: string;
    message?: string;
    json?: boolean;
  }
): Promise<number> {
  if (!opts.personnummer && !opts.orgnr)
    throw new Error("one subject is required: --personnummer <pnr> or --orgnr <org.nr>.");
  if (opts.personnummer && opts.orgnr)
    throw new Error("provide only one of --personnummer or --orgnr.");
  if (!opts.case) throw new Error("--case <invstgtnId> is required.");
  if (!opts.legalBasis) throw new Error("--legal-basis <mandate> is required.");

  const body: DirectKycRequest = {
    ...responderLocator(opts),
    subjectPersonnummer: opts.personnummer,
    subjectOrgNr: opts.orgnr,
    invstgtnId: opts.case,
    legalBasis: opts.legalBasis,
    message: opts.message,
  };

  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  const res = await client.createDirectKyc(body);
  if (opts.json) {
    printJson(res);
    return 0;
  }
  line(`Created KYC/CDD request ${res.requestId}`);
  line(`  type:      ${res.workflowType ?? "KYC_CDD_CHECK_V1"}`);
  if (res.status) line(`  status:    ${res.status}`);
  if (res.responderOrgId) line(`  responder: ${res.responderOrgId}`);
  line("");
  line(`Track it:  qp requests show ${res.requestId}`);
  return 0;
}

/**
 * `qp requests create information` — a free-text (unstructured) information
 * request to a named responder, when a structured tx-history/KYC check isn't the
 * right shape and the authority needs to ask in plain language.
 */
export async function runCreateInformation(
  env: ReqportEnv,
  opts: {
    responder?: string;
    responderOrg?: string;
    request?: string;
    case?: string;
    legalBasis?: string;
    personnummer?: string;
    orgnr?: string;
    json?: boolean;
  }
): Promise<number> {
  if (!opts.request) throw new Error("--request <text> is required (the free-text ask).");
  if (opts.personnummer && opts.orgnr) throw new Error("provide only one of --personnummer or --orgnr.");
  if (!opts.case) throw new Error("--case <invstgtnId> is required.");
  if (!opts.legalBasis) throw new Error("--legal-basis <mandate> is required.");

  const body: DirectInformationRequest = {
    ...responderLocator(opts),
    request: opts.request,
    invstgtnId: opts.case,
    legalBasis: opts.legalBasis,
    subjectPersonnummer: opts.personnummer,
    subjectOrgNr: opts.orgnr,
  };

  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  const res = await client.createDirectInformation(body);
  if (opts.json) {
    printJson(res);
    return 0;
  }
  line(`Created information request ${res.requestId}`);
  line(`  type:      ${res.workflowType ?? "AUTHORITY_REQUEST_V1"}`);
  if (res.status) line(`  status:    ${res.status}`);
  if (res.responderOrgId) line(`  responder: ${res.responderOrgId}`);
  line("");
  line(`Track it:  qp requests show ${res.requestId}`);
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
    line(`  qp respond ${id} --has-relationship true --account ACCOUNT:SE1234567890:IBAN:Main \\`);
    line(`      --relationship-types CUSTOMER,ACCOUNT_HOLDER   # optional but recommended: enables a targeted follow-up (data minimisation)`);
  } else if (isTransactionHistory(wf.workflowType)) {
    line("Answer it with a camt.053-CA statement (an open crypto-asset profile of ISO 20022 camt.053):");
    line(`  qp respond ${id} --statement ./statement.json   # inline; validated + sealed server-side`);
  } else {
    line("Answer it:");
    line(`  qp respond ${id} --status NFOU`);
    line(`  qp respond ${id} --status COMP --free-text "…"`);
  }
  return 0;
}
