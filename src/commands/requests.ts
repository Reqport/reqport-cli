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

/** Short date (YYYY-MM-DD) from an ISO timestamp, or "" when absent. */
function shortDate(iso?: string | null): string {
  if (!iso) return "";
  return String(iso).slice(0, 10);
}

/** Display reference: authority case → diarienummer → requestNumber → short id. */
function referenceOf(item: {
  invstgtnId?: string | null;
  diarienummer?: string | null;
  requestNumber?: string | null;
  workflowId: string;
}): string {
  const r = item.invstgtnId ?? item.diarienummer ?? item.requestNumber;
  if (r && String(r).trim()) return String(r).trim();
  const id = String(item.workflowId ?? "").replace(/-/g, "");
  return id.slice(-8).toUpperCase() || "—";
}

/**
 * `qp requests list` — reads the SAME unified `/v1/workflows/requests` projection
 * the portal workspace list uses (server-resolved counterparty name, type
 * descriptor and status phase), so the CLI and portal show one consistent view.
 * The raw responder-edge affordances view stays available via `client.listAffordances`
 * for commands that need it (e.g. fir / kyc discovery, doctor).
 */
export async function runList(
  env: ReqportEnv,
  opts: { state?: string; type?: string; mine?: boolean; json?: boolean }
): Promise<number> {
  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  // `--state` maps to the projection's filter (open | in_progress | responded | closed).
  const filter = opts.state ?? "open";
  const res = await client.listRequests({ filter });

  let items = res.items ?? [];
  // `--mine` narrows to requests THIS org sent (OUTGOING); default shows all.
  if (opts.mine) items = items.filter((i) => i.direction === "OUTGOING");
  // `--type` filters client-side on the resolved family / label / raw type.
  if (opts.type) {
    const needle = opts.type.toLowerCase();
    items = items.filter((i) => {
      const hay = [
        i.typeDescriptor?.family,
        i.typeDescriptor?.label,
        i.requestType,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }

  if (opts.json) {
    printJson({ items });
    return 0;
  }

  if (items.length === 0) {
    line(
      `No ${opts.mine ? "owned" : ""} requests in "${filter}"${opts.type ? ` of type ${opts.type}` : ""}.`
    );
    line(
      `(Sandbox is seeded by the synthetic authority reqport-authority-test.com; if empty, seeding may not have reached your org yet.)`
    );
    return 0;
  }

  const rows: string[][] = items.map((item) => [
    item.workflowId,
    item.counterpartyName ??
      item.counterpartyOrgId ??
      item.requesterName ??
      item.requesterOrgId ??
      "—",
    item.typeDescriptor?.label ?? item.requestType ?? "",
    item.statusPhase ?? item.status ?? "",
    referenceOf(item),
    shortDate(item.createdAt),
    shortDate(item.deadline),
  ]);

  line(
    table(
      ["REQUEST ID", "COUNTERPARTY", "TYPE", "STATUS", "REFERENCE", "CREATED", "DEADLINE"],
      rows
    )
  );
  line("");
  line(`${items.length} request(s). Read one:  qp requests show <REQUEST ID>`);
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

/**
 * `qp requests create free-text` — the going-forward free-text member of the
 * request family: an authority-gated ask stated in plain language, for when no
 * structured profile (business-relationship / tx-history / KYC) is the right
 * shape. Modelled as a single graph-native free-text edge that supersedes and
 * decommissions the legacy AUTHORITY_REQUEST_V1 and UNSTRUCTURED_AUTHORITY_REQUEST_V1
 * workflow types. The responder answers on the generic response path.
 *
 * NOTE: the wire endpoint/edge name is unsettled; this reuses the existing
 * free-text create path (createDirectInformation → POST /v1/requests/information)
 * as a placeholder pending the kernel/vanta collapse PRs.
 */
export async function runCreateFreeText(
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
  line(`Created free-text authority request ${res.requestId}`);
  line(`  type:      ${res.workflowType ?? "free-text (graph-native; wire code pending reconciliation)"}`);
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
