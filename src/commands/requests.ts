/**
 * `reqport requests list` and `reqport requests show <id>`.
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { line, printJson, table } from "../ui.js";
import type {
  AnswerData,
  AttachmentsData,
  DirectInformationRequest,
  DirectKycRequest,
  DirectTransactionHistoryRequest,
  LegalBasisData,
  OverviewData,
  PartiesSectionData,
  RequestBodyData,
  RequestView,
  RequestViewSection,
  TimelineData,
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
 * shape. It is a graph-native ask that produces an UnstructuredData response:
 * vanta dual-writes it to `edge.information.v1` (subject-anchored — a person/org
 * node → UnstructuredData) when a subject is attached, else to the sourceless
 * `edge.general-information.v1`. Supersedes and decommissions the legacy
 * AUTHORITY_REQUEST_V1 and UNSTRUCTURED_AUTHORITY_REQUEST_V1 workflow types. The
 * responder answers on the generic response path with a free-text / UnstructuredData
 * response.
 *
 * The create call flows through createDirectInformation (POST /v1/requests/information);
 * vanta's binding maps it to the graph edge above.
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
  line(`  type:      ${res.workflowType ?? "free-text (graph-native; UnstructuredData response)"}`);
  if (res.status) line(`  status:    ${res.status}`);
  if (res.responderOrgId) line(`  responder: ${res.responderOrgId}`);
  line("");
  line(`Track it:  qp requests show ${res.requestId}`);
  return 0;
}

/** Human labels for the normalized section kinds the view emits. */
const SECTION_TITLES: Record<string, string> = {
  overview: "Overview",
  parties: "Subjects",
  legalBasis: "Legal basis",
  requestBody: "Request",
  answer: "Answer",
  attachments: "Attachments",
  timeline: "Timeline",
};

/** Two-space-indent a (possibly multi-line) block under a section. */
function indent(s: string, pad = "  "): string {
  return s
    .split("\n")
    .map((l) => (l.length ? pad + l : l))
    .join("\n");
}

/**
 * Render one typed section from the server-assembled view. Each `kind` gets a
 * small formatter; an unknown kind is printed with its raw data rather than
 * crashing, so a newly-added section type degrades gracefully.
 */
function renderSection(section: RequestViewSection): void {
  const title = SECTION_TITLES[section.kind] ?? section.kind;
  line(`${title}:`);
  const data = section.data as unknown;

  switch (section.kind) {
    case "overview": {
      const fields = (data as OverviewData)?.fields ?? [];
      if (fields.length === 0) {
        line(indent("(no fields)"));
        break;
      }
      for (const f of fields) {
        line(indent(`${f.label ?? ""}: ${f.value ?? ""}`));
      }
      break;
    }
    case "parties": {
      const subjects = (data as PartiesSectionData)?.subjects ?? [];
      if (subjects.length === 0) {
        line(indent("(no subjects)"));
        break;
      }
      for (const s of subjects) {
        const scheme = s.scheme ? ` [${s.scheme}]` : "";
        const label = s.label ? `${s.label}: ` : "";
        line(indent(`${s.kind ?? "OTHER"}  ${label}${s.identifier ?? ""}${scheme}`));
      }
      break;
    }
    case "legalBasis": {
      const bases = (data as LegalBasisData)?.bases ?? [];
      if (bases.length === 0) {
        line(indent("(none stated)"));
        break;
      }
      for (const b of bases) line(indent(`- ${b}`));
      break;
    }
    case "requestBody": {
      const prose = (data as RequestBodyData)?.prose;
      line(indent(prose && prose.trim() ? prose : "(no free-text body)"));
      break;
    }
    case "answer": {
      const a = data as AnswerData;
      if (a?.outcome) line(indent(`outcome: ${a.outcome}`));
      if (a?.hasRelationship !== undefined && a?.hasRelationship !== null) {
        line(indent(`has relationship: ${a.hasRelationship}`));
      }
      if (a?.relationshipTypes && a.relationshipTypes.length > 0) {
        line(indent(`relationship types: ${a.relationshipTypes.join(", ")}`));
      }
      for (const ac of a?.accounts ?? []) {
        const scheme = ac.scheme ? `:${ac.scheme}` : "";
        const label = ac.label ? ` (${ac.label})` : "";
        const chain = ac.chain ? ` on ${ac.chain}` : "";
        line(indent(`${ac.instrumentType ?? "ACCOUNT"} ${ac.identifier ?? ""}${scheme}${label}${chain}`));
      }
      if (a?.note) line(indent(`note: ${a.note}`));
      break;
    }
    case "attachments": {
      const entries = (data as AttachmentsData)?.entries ?? [];
      if (entries.length === 0) {
        line(indent("(none)"));
        break;
      }
      for (const e of entries) {
        const dir = e.direction ? `${e.direction} ` : "";
        const at = e.at ? ` @ ${e.at}` : "";
        line(indent(`${dir}${e.payloadId ?? ""}${at}`));
      }
      line(indent("(decrypt bytes with: qp requests show <id> then decrypt-batch)"));
      break;
    }
    case "timeline": {
      const events = (data as TimelineData)?.events ?? [];
      if (events.length === 0) {
        line(indent("(no events)"));
        break;
      }
      for (const ev of events) {
        const dir = ev.direction ? `${ev.direction} ` : "";
        const at = ev.at ? `${ev.at}  ` : "";
        line(indent(`${at}${dir}${ev.type ?? ""}`));
      }
      break;
    }
    default: {
      // Unknown/forward-compatible kind — never crash; show the raw data.
      line(indent("(unrecognized section kind — raw data below)"));
      line(indent(JSON.stringify(data, null, 2)));
      break;
    }
  }
  line("");
}

/**
 * `qp requests show <id>` — render a request from the server-assembled VIEW
 * endpoint `GET /v1/workflows/{id}/view`. Vanta decrypts the caller's own copy
 * in the TEE and returns a render-ready model: an identity header, the parties +
 * the caller's role, and a uniform list of typed `sections[]`. The CLI walks the
 * sections and draws each `kind`, so it shows the SAME section-typed model the
 * portal renders (unknown kinds degrade to their raw data rather than crash).
 *
 * (Repointed from the previous getWorkflow + request-payload + decrypt-batch
 * read; that server-assisted decrypt path still backs `qp respond --show` via
 * `readRequest` in core.ts.)
 */
export async function runShow(
  env: ReqportEnv,
  id: string,
  opts: { json?: boolean }
): Promise<number> {
  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  const view = await client.getRequestView(id);

  if (opts.json) {
    printJson(view);
    return 0;
  }

  const identity = view.identity ?? {};
  const parties = view.parties ?? {};
  const role = parties.role ?? "";

  // Identity header: title + case number + status.
  line(identity.title ? `${identity.title}` : `Request ${view.id}`);
  line(`  id:        ${view.id}`);
  if (view.type) line(`  type:      ${view.type}`);
  if (identity.caseNumber) line(`  case #:    ${identity.caseNumber}`);
  const statusKind =
    identity.statusKind && identity.statusKind !== identity.status
      ? ` (${identity.statusKind})`
      : "";
  if (identity.status || identity.statusKind) {
    line(`  status:    ${identity.status ?? identity.statusKind}${statusKind}`);
  }

  // Parties + the caller's role.
  const requester = parties.requester;
  const responder = parties.responder;
  if (requester) {
    line(`  requester: ${requester.name ?? requester.orgId}${requester.name ? ` (${requester.orgId})` : ""}`);
  }
  if (responder) {
    line(`  responder: ${responder.name ?? responder.orgId}${responder.name ? ` (${responder.orgId})` : ""}`);
  }
  if (role) {
    line(`  you are:   ${role === "RESPONDER" ? "the RESPONDER (you answer this)" : role}`);
  }

  // Capabilities (what the caller may do next), when any are true.
  const caps = view.capabilities;
  if (caps) {
    const can = [
      caps.canRespond ? "respond" : null,
      caps.canMessage ? "message" : null,
      caps.canClaim ? "claim" : null,
    ].filter(Boolean);
    if (can.length > 0) line(`  can:       ${can.join(", ")}`);
  }
  line("");

  // Walk the render-ready sections in server order.
  const sections = view.sections ?? [];
  if (sections.length === 0) {
    line("(no sections)");
  } else {
    for (const section of sections) renderSection(section);
  }

  // Responder next-step hint (the view's capabilities drive it; the per-type
  // answer flags live on `qp respond`).
  if (caps?.canRespond) {
    line(`Answer it:  qp respond ${id} --help   # picks the right answer flags for this type`);
  }
  return 0;
}
