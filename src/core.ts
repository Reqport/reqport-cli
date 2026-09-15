/**
 * Shared responder logic used by BOTH the CLI commands and the MCP tools, so
 * the two surfaces behave identically. No console output here — callers render.
 */

import { readFile } from "node:fs/promises";
import { ReqportApiError, ReqportClient } from "./client.js";
import {
  FIR_ABOUT_PARTIES,
  FIR_CLOSE_REASONS,
  FIR_FRAUD_STATUSES,
  FIR_IDENTITY_RECORD_STATUSES,
  FIR_OUTCOMES,
  FIR_RECEIVER_ACCOUNT_TYPES,
  FIR_UPDATE_TYPES,
  KYC_PEP_STATUSES,
  KYC_RECORD_STATUSES,
  KYC_RELATIONSHIP_STATUSES,
  KYC_RISK_RATINGS,
  KYC_STATUSES,
  RELATIONSHIP_TYPES,
  type AccountInstrument,
  type AffordanceGroup,
  type AffordanceListResponse,
  type CddRecord,
  type ChatTarget,
  type DecodedPayload,
  type FirCaseView,
  type FirCloseRequest,
  type FirConfirmRefundRequest,
  type FirCreateNoticeRequest,
  type FirIdentityRequestRequest,
  type FirIdentityResponseRequest,
  type FirLegalBasis,
  type FirOpenCaseResult,
  type FirOutcome,
  type FirRefundInstructionRequest,
  type FirResponseOutcome,
  type FirSubmitResponseRequest,
  type FirUpdateRequest,
  type KycRecordStatus,
  type KycResponseSubmission,
  type KycResponseView,
  type PayloadMetaResponse,
  type RelationshipType,
  type ResponseResult,
  type WorkflowInstanceResponse,
} from "./types.js";

/** Does this workflow type use the purpose-built business-relationship endpoint? */
export function isBusinessRelationship(workflowType: string | undefined): boolean {
  if (!workflowType) return false;
  return workflowType.toUpperCase().includes("BUSINESS_RELATIONSHIP");
}

/** Does this workflow type use the crypto transaction-history statement endpoint? */
export function isTransactionHistory(workflowType: string | undefined): boolean {
  if (!workflowType) return false;
  return workflowType.toUpperCase().includes("TRANSACTION_HISTORY");
}

/** Decode base64 plaintext into text + parsed JSON (best effort). */
function decodeItem(
  payloadId: string,
  ok: boolean,
  contentType?: string | null,
  plaintextBase64?: string | null,
  errorCode?: string | null
): DecodedPayload {
  if (!ok || !plaintextBase64) {
    return { payloadId, ok: false, contentType, errorCode };
  }
  const text = Buffer.from(plaintextBase64, "base64").toString("utf-8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { payloadId, ok: true, contentType, text, json };
}

/** Decrypt up to 20 payloads and return decoded results in request order. */
export async function decodePayloads(
  client: ReqportClient,
  payloadIds: string[]
): Promise<DecodedPayload[]> {
  if (payloadIds.length === 0) return [];
  const res = await client.decryptBatch(payloadIds);
  return res.items.map((i) =>
    decodeItem(i.payloadId, i.ok, i.contentType, i.plaintextBase64, i.errorCode)
  );
}

export type RequestDetail = {
  workflow: WorkflowInstanceResponse;
  requestPayload?: PayloadMetaResponse;
  /** The decrypted request content, when a request payload exists and decrypts. */
  decoded?: DecodedPayload;
  /** Non-fatal note explaining a missing/failed request-payload read. */
  readNote?: string;
};

/**
 * Full read of one request: workflow row + request-payload metadata + a
 * server-assisted decrypt of that payload. Missing/undecryptable payloads are
 * reported via readNote rather than thrown (an NFOU-style request may carry
 * only a header).
 */
export async function readRequest(
  client: ReqportClient,
  id: string
): Promise<RequestDetail> {
  const workflow = await client.getWorkflow(id);
  let requestPayload: PayloadMetaResponse | undefined;
  try {
    requestPayload = await client.getRequestPayload(id);
  } catch (e) {
    return {
      workflow,
      readNote:
        e instanceof ReqportApiError
          ? `No readable request payload (request-payload ${e.status}).`
          : `Could not read request payload: ${(e as Error).message}`,
    };
  }
  if (!requestPayload?.payloadId) {
    return { workflow, requestPayload, readNote: "Request has no payloadId." };
  }
  const [decoded] = await decodePayloads(client, [requestPayload.payloadId]);
  return {
    workflow,
    requestPayload,
    decoded,
    readNote:
      decoded && !decoded.ok
        ? `Request payload did not decrypt (${decoded.errorCode ?? "unknown"}).`
        : undefined,
  };
}

/**
 * Parse an --account argument of the form
 *   TYPE:identifier[:scheme[:label]]
 * e.g. ACCOUNT:SE123:IBAN:Main or WALLET:0xabc or CARD:411111******1111:PAN:Visa
 */
export function parseAccountArg(raw: string): AccountInstrument {
  const parts = raw.split(":");
  const type = (parts[0] ?? "").toUpperCase();
  if (type !== "ACCOUNT" && type !== "WALLET" && type !== "CARD") {
    throw new Error(
      `Invalid --account "${raw}": type must be ACCOUNT, WALLET or CARD (format TYPE:identifier[:scheme[:label]]).`
    );
  }
  const identifier = parts[1];
  if (!identifier) {
    throw new Error(
      `Invalid --account "${raw}": missing identifier (format TYPE:identifier[:scheme[:label]]).`
    );
  }
  const instrument: AccountInstrument = { instrumentType: type, identifier };
  if (parts[2]) instrument.scheme = parts[2];
  if (parts.length > 3) instrument.label = parts.slice(3).join(":");
  return instrument;
}

/**
 * Parse a comma-separated `--relationship-types` argument into a validated list
 * of RelationshipType values. Values are upper-cased and de-duplicated; an
 * unknown value throws an error that lists the valid values. Empty/whitespace
 * entries are dropped. Shared by the CLI respond command (the MCP tool validates
 * via a zod enum instead).
 */
export function parseRelationshipTypes(raw: string): RelationshipType[] {
  const seen = new Set<RelationshipType>();
  for (const part of raw.split(",")) {
    const v = part.trim().toUpperCase();
    if (v === "") continue;
    if (!(RELATIONSHIP_TYPES as readonly string[]).includes(v)) {
      throw new Error(
        `Invalid --relationship-types value "${part.trim()}". Valid values: ${RELATIONSHIP_TYPES.join(", ")}.`
      );
    }
    seen.add(v as RelationshipType);
  }
  return [...seen];
}

/**
 * Parse a `--target <kind>:<id>` argument into a {kind,id} ChatTarget. The kind
 * must be `node` or `edge`; the id is the remainder (allowing colons, though
 * ids are normally UUIDs). Shared by the chat + attachment commands and MCP.
 */
export function parseTarget(raw: string): ChatTarget {
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    throw new Error(
      `Invalid --target "${raw}": expected <kind>:<id> where kind is node or edge (e.g. node:<uuid>).`
    );
  }
  const kind = raw.slice(0, idx).toLowerCase();
  const id = raw.slice(idx + 1);
  if (kind !== "node" && kind !== "edge") {
    throw new Error(
      `Invalid --target "${raw}": kind must be "node" or "edge" (got "${kind}").`
    );
  }
  if (!id) {
    throw new Error(`Invalid --target "${raw}": missing id after "${kind}:".`);
  }
  return { kind, id };
}

/** A small extension → MIME-type map for attachment uploads. */
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Infer a MIME type from a filename's extension, defaulting to
 * application/octet-stream when unknown.
 */
export function mimeTypeForFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export type RespondInput = {
  /** Business-relationship answer (true/false). Undefined for the generic path. */
  hasRelationship?: boolean;
  /** Generic-path status when not a business-relationship request. */
  status?: "COMP" | "NFOU";
  note?: string;
  accounts?: AccountInstrument[];
  /**
   * Business-relationship path: optional relationship-type tags on a true answer
   * (ignored/omitted when hasRelationship is false).
   */
  relationshipTypes?: RelationshipType[];
  /** A pre-sealed answer document payloadId (advanced). */
  payloadId?: string;
  /** Generic-path free-text answer. */
  freeText?: string;
  /**
   * Transaction-history path: the parsed camt.053-CA statement object, sent
   * inline and sealed server-side.
   */
  statement?: unknown;
};

export type RespondOutcome = {
  endpoint:
    | "business-relationship-response"
    | "transaction-history-response"
    | "response";
  workflowType: string;
  requestId: string;
  submitted: Record<string, unknown>;
  result: ResponseResult;
};

/**
 * Decide the endpoint from the workflow type and submit the answer. Reused by
 * the CLI `respond` command and the MCP tool.
 */
export async function performRespond(
  client: ReqportClient,
  id: string,
  input: RespondInput
): Promise<RespondOutcome> {
  const workflow = await client.getWorkflow(id);
  const br = isBusinessRelationship(workflow.workflowType);

  if (br) {
    const hasRelationship =
      input.hasRelationship ??
      (input.status === "COMP" ? true : input.status === "NFOU" ? false : undefined);
    if (hasRelationship === undefined) {
      throw new Error(
        "This is a business-relationship check — pass hasRelationship (true/false)."
      );
    }
    const answer: Record<string, unknown> = { hasRelationship };
    if (input.note) answer.note = input.note;
    if (hasRelationship) {
      if (input.accounts && input.accounts.length > 0) answer.accounts = input.accounts;
      if (input.payloadId) answer.payloadId = input.payloadId;
      // Optional relationship-type tags (only on a true answer, only when non-empty).
      if (input.relationshipTypes && input.relationshipTypes.length > 0) {
        answer.relationshipTypes = input.relationshipTypes;
      }
      if (!answer.accounts && !answer.payloadId) {
        throw new Error(
          "A true answer must disclose at least one --account (inline typed instrument) or a --payload-id (pre-sealed answer document)."
        );
      }
    }
    const result = await client.submitBusinessRelationshipResponse(id, answer as never);
    return {
      endpoint: "business-relationship-response",
      workflowType: workflow.workflowType,
      requestId: id,
      submitted: answer,
      result,
    };
  }

  // Crypto transaction-history path — inline camt.053-CA statement, sealed server-side.
  if (isTransactionHistory(workflow.workflowType)) {
    if (input.statement === undefined) {
      throw new Error(
        "This is a transaction-history request — pass a camt.053-CA statement (--statement <file.json>)."
      );
    }
    const answer: Record<string, unknown> = { statement: input.statement };
    if (input.note) answer.note = input.note;
    const result = await client.submitTransactionHistoryResponse(id, answer as never);
    return {
      endpoint: "transaction-history-response",
      workflowType: workflow.workflowType,
      requestId: id,
      // Redact the statement body from the echoed submission (it may be large
      // and carry subject data); the server validated + sealed it.
      submitted: { statement: "(camt.053-CA statement)", ...(input.note ? { note: input.note } : {}) },
      result,
    };
  }

  // Generic responder path.
  const status =
    input.status ??
    (input.hasRelationship === true
      ? "COMP"
      : input.hasRelationship === false
        ? "NFOU"
        : undefined);
  if (!status) {
    throw new Error(
      "Pass --status COMP or --status NFOU for this request type."
    );
  }
  const items = [] as NonNullable<Parameters<typeof client.submitResponse>[1]["items"]>;
  if (input.freeText) {
    items.push({ mode: "unstructured", freeText: input.freeText });
  }
  if (input.payloadId) {
    items.push({
      mode: "structured",
      document: { docType: "ATTACHMENT", payloadId: input.payloadId },
    });
  }
  const submission = {
    status,
    items,
    ...(input.note ? { note: input.note } : {}),
    ...(input.accounts && input.accounts.length > 0 ? { accounts: input.accounts } : {}),
  };
  if (status === "COMP" && items.length === 0 && (!input.accounts || input.accounts.length === 0)) {
    throw new Error(
      "A COMP response must carry at least one item (--free-text or --payload-id) or a disclosed --account."
    );
  }
  const result = await client.submitResponse(id, submission as never);
  return {
    endpoint: "response",
    workflowType: workflow.workflowType,
    requestId: id,
    submitted: submission as Record<string, unknown>,
    result,
  };
}

// ── FIR — Fraud Incident Response ─────────────────────────────────────────────

/** The workflow type of a FIR case (one workflow instance per case). */
export const FIR_WORKFLOW_TYPE = "FIR_FRAUD_CASE_V1";

/**
 * Does this workflow/edge type belong to a FIR case? Used to filter the shared
 * /v1/affordances discovery down to FIR cases (there is no list-cases endpoint).
 * Kept broad so it matches whether the affordance projection labels the edge as
 * the workflow type (FIR_FRAUD_CASE_V1) or a kernel fraud edge.
 */
export function isFirWorkflowType(t: string | undefined): boolean {
  if (!t) return false;
  const u = t.toUpperCase();
  return u.includes("FIR_FRAUD") || u.includes("FRAUD_INCIDENT") || u.includes("FRAUD_CLAIM");
}

/** The FIR-case affordance groups from a /v1/affordances response. */
export function firAffordanceGroups(res: AffordanceListResponse): AffordanceGroup[] {
  return (res.groups ?? []).filter((g) => isFirWorkflowType(g.edgeType));
}

/**
 * Read a JSON body from a `--file <path>` and/or an inline `--body <json>` (at
 * most one). Returns undefined when neither is given. Shared by the FIR commands.
 */
export async function readJsonInput(
  input: { file?: string; body?: string },
  label: string
): Promise<unknown> {
  if (input.file !== undefined && input.body !== undefined) {
    throw new Error(`Provide only one of --file or --body for ${label}.`);
  }
  let raw: string;
  if (input.file !== undefined) {
    try {
      raw = await readFile(input.file, "utf-8");
    } catch (e) {
      throw new Error(`Cannot read --file "${input.file}" for ${label}: ${(e as Error).message}`);
    }
  } else if (input.body !== undefined) {
    raw = input.body;
  } else {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label}: input is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * Parse a `--outcome <transaction_ref>:<OUTCOME>[:<heldAmount>:<currency>]`
 * argument into a validated FirResponseOutcome. The outcome enum is validated
 * (listing valid values on error); a held amount, when present, needs BOTH the
 * amount and currency and is carried as a decimal STRING.
 */
export function parseFirOutcomeArg(raw: string): FirResponseOutcome {
  const parts = raw.split(":");
  const transactionRef = (parts[0] ?? "").trim();
  if (!transactionRef) {
    throw new Error(
      `Invalid --outcome "${raw}": missing transaction ref (format <transaction_ref>:<OUTCOME>[:<heldAmount>:<currency>]).`
    );
  }
  const outcome = (parts[1] ?? "").trim().toUpperCase();
  if (!(FIR_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error(
      `Invalid --outcome "${raw}": outcome must be one of ${FIR_OUTCOMES.join(", ")}.`
    );
  }
  const result: FirResponseOutcome = { transactionRef, outcome: outcome as FirOutcome };
  const amount = parts[2]?.trim();
  const currency = parts[3]?.trim();
  if (amount || currency) {
    if (!amount || !currency) {
      throw new Error(
        `Invalid --outcome "${raw}": a held amount needs both amount and currency (…:<heldAmount>:<currency>).`
      );
    }
    result.heldAmount = { amount, currency };
  }
  return result;
}

/** Validate a FIR RESPONSE outcome's enum (used for flag- and file-built outcomes). */
export function validateFirOutcome(o: FirResponseOutcome): void {
  if (!o || typeof o !== "object") throw new Error("each outcome must be an object.");
  if (!o.transactionRef) throw new Error("each outcome requires a transactionRef.");
  if (!(FIR_OUTCOMES as readonly string[]).includes(o.outcome)) {
    throw new Error(
      `Invalid outcome "${String(o.outcome)}" for ${o.transactionRef}: must be one of ${FIR_OUTCOMES.join(", ")}.`
    );
  }
}

/**
 * Validate a create-notice body's required top-level fields (client-side, before
 * the POST): sender, recipient, recipientOrgId, a notice with ≥1 transaction, and
 * each transaction's receiver.accountType constrained to the pooled/non-personal
 * set (CLIENT_FUNDS | OMNIBUS | MERCHANT).
 */
export function validateFirCreateNotice(body: FirCreateNoticeRequest): void {
  if (!body || typeof body !== "object") throw new Error("a notice body is required.");
  if (!body.sender) throw new Error("sender is required.");
  if (!body.recipient) throw new Error("recipient is required.");
  if (!body.recipientOrgId) throw new Error("recipientOrgId (the delivery target org id) is required.");
  if (!body.notice) throw new Error("notice is required.");
  const txns = body.notice.transactions;
  if (!Array.isArray(txns) || txns.length === 0) {
    throw new Error("notice.transactions must contain at least one transaction.");
  }
  txns.forEach((t, i) => {
    const at = t?.receiver?.accountType;
    if (!at) {
      throw new Error(`notice.transactions[${i}].receiver.accountType is required.`);
    }
    if (!(FIR_RECEIVER_ACCOUNT_TYPES as readonly string[]).includes(at)) {
      throw new Error(
        `notice.transactions[${i}].receiver.accountType "${at}" is invalid — must be one of ${FIR_RECEIVER_ACCOUNT_TYPES.join(", ")}.`
      );
    }
  });
}

/** Open a FIR case with a NOTICE. Validates then POSTs. Shared by CLI + MCP. */
export async function performFirNotify(
  client: ReqportClient,
  body: FirCreateNoticeRequest
): Promise<FirOpenCaseResult> {
  validateFirCreateNotice(body);
  return client.createFirNotice(body);
}

/** Submit a FIR RESPONSE (per-transaction outcomes). Validates then POSTs. */
export async function performFirRespond(
  client: ReqportClient,
  firId: string,
  body: FirSubmitResponseRequest
): Promise<ResponseResult> {
  if (!body.sender) throw new Error("sender is required.");
  if (!body.recipient) throw new Error("recipient is required.");
  if (!Array.isArray(body.outcomes) || body.outcomes.length === 0) {
    throw new Error("at least one response outcome is required (--outcome, or a --file/--body).");
  }
  body.outcomes.forEach(validateFirOutcome);
  return client.submitFirResponse(firId, body);
}

/** Instruct a FIR refund. Validates then POSTs. */
export async function performFirInstructRefund(
  client: ReqportClient,
  firId: string,
  body: FirRefundInstructionRequest
): Promise<Record<string, unknown>> {
  if (!body.sender) throw new Error("sender is required.");
  if (!body.recipient) throw new Error("recipient is required.");
  const ri = body.refundInstruction;
  if (!ri || typeof ri !== "object") throw new Error("refundInstruction is required.");
  if (!ri.transactionRef) throw new Error("refundInstruction.transactionRef is required.");
  if (!ri.returnTo) throw new Error("refundInstruction.returnTo (the return account) is required.");
  return client.instructFirRefund(firId, body);
}

/** Confirm a FIR refund via a pre-sealed RefundExecution payloadId. Validates then POSTs. */
export async function performFirConfirmRefund(
  client: ReqportClient,
  firId: string,
  body: FirConfirmRefundRequest
): Promise<ResponseResult> {
  if (!body.sender) throw new Error("sender is required.");
  if (!body.recipient) throw new Error("recipient is required.");
  if (!body.payloadId) {
    throw new Error(
      "--payload-id (a pre-sealed RefundExecution payloadId, docType FIR_REFUND_JSON) is required."
    );
  }
  return client.confirmFirRefund(firId, body);
}

/** Read a FIR case (content-blind metadata). */
export async function readFirCase(client: ReqportClient, firId: string): Promise<FirCaseView> {
  return client.getFirCase(firId);
}

// ── FIR identity-exchange (identity-request / identity-response) ───────────────

/**
 * Validate a FIR legal basis client-side: it must be present and carry AT LEAST
 * ONE field (token, scheme, reference, or description) — mirroring the vanta gate.
 */
export function validateFirLegalBasis(lb: FirLegalBasis | undefined): void {
  if (!lb || typeof lb !== "object") {
    throw new Error(
      "legalBasis is required (at least one of: token, scheme, reference, description)."
    );
  }
  if (!lb.token && !lb.scheme && !lb.reference && !lb.description) {
    throw new Error(
      "legalBasis must carry at least one field: --legal-basis <text>, or --legal-basis-token / --legal-basis-scheme / --legal-basis-reference."
    );
  }
}

/**
 * Submit a FIR identity-request. Validates client-side (sender, recipient, the
 * IdentityRequest's transactionRef + aboutParty enum, and legal-basis presence)
 * BEFORE the POST. Shared by CLI + MCP.
 */
export async function performFirIdentityRequest(
  client: ReqportClient,
  firId: string,
  body: FirIdentityRequestRequest
): Promise<Record<string, unknown>> {
  if (!body.sender) throw new Error("sender is required.");
  if (!body.recipient) throw new Error("recipient is required.");
  const ir = body.identityRequest;
  if (!ir || typeof ir !== "object") throw new Error("identityRequest is required.");
  if (!ir.transactionRef) throw new Error("identityRequest.transactionRef is required.");
  if (!ir.aboutParty) {
    throw new Error("identityRequest.aboutParty is required (ORDER_CUSTOMER | ORIGINATOR).");
  }
  if (!(FIR_ABOUT_PARTIES as readonly string[]).includes(ir.aboutParty)) {
    throw new Error(
      `aboutParty "${String(ir.aboutParty)}" is invalid — must be one of ${FIR_ABOUT_PARTIES.join(", ")}.`
    );
  }
  validateFirLegalBasis(ir.legalBasis);
  return client.submitFirIdentityRequest(firId, body);
}

/**
 * Submit a FIR identity-response. Validates client-side (sender, recipient, the
 * IdentityResponse's transactionRef + recordStatus enum) BEFORE the POST, and
 * guards against supplying BOTH an inline subject AND a pre-sealed payloadId.
 * Shared by CLI + MCP.
 */
export async function performFirIdentityRespond(
  client: ReqportClient,
  firId: string,
  body: FirIdentityResponseRequest
): Promise<ResponseResult> {
  if (!body.sender) throw new Error("sender is required.");
  if (!body.recipient) throw new Error("recipient is required.");
  const ir = body.identityResponse;
  if (!ir || typeof ir !== "object") throw new Error("identityResponse is required.");
  if (!ir.transactionRef) {
    throw new Error("identityResponse.transactionRef is required (--transaction-ref, or a --file/--body).");
  }
  if (!ir.recordStatus) {
    throw new Error("record_status is required (FOUND | NOT_FOUND).");
  }
  if (!(FIR_IDENTITY_RECORD_STATUSES as readonly string[]).includes(ir.recordStatus)) {
    throw new Error(
      `record_status "${String(ir.recordStatus)}" is invalid — must be one of ${FIR_IDENTITY_RECORD_STATUSES.join(", ")}.`
    );
  }
  if (ir.aboutParty && !(FIR_ABOUT_PARTIES as readonly string[]).includes(ir.aboutParty)) {
    throw new Error(
      `aboutParty "${String(ir.aboutParty)}" is invalid — must be one of ${FIR_ABOUT_PARTIES.join(", ")}.`
    );
  }
  if (ir.subject && body.payloadId) {
    throw new Error(
      "Provide EITHER an inline subject OR a pre-sealed --payload-id, not both."
    );
  }
  return client.submitFirIdentityResponse(firId, body);
}

// ── FIR lifecycle (update / close) ─────────────────────────────────────────────

/**
 * Validate a FIR UPDATE body client-side (before the POST): sender + recipient are
 * required; the nested update payload's update_type is required and enum-valid;
 * status, when present, must be a valid fraud status; and update_type=STATUS_CHANGE
 * requires a status (mirroring the vanta gate).
 */
export function validateFirUpdate(body: FirUpdateRequest): void {
  if (!body || typeof body !== "object") throw new Error("an update body is required.");
  if (!body.sender) throw new Error("sender is required.");
  if (!body.recipient) throw new Error("recipient is required.");
  const u = body.update;
  if (!u || typeof u !== "object") throw new Error("update is required.");
  if (!u.update_type) {
    throw new Error(`update_type is required (one of ${FIR_UPDATE_TYPES.join(", ")}).`);
  }
  if (!(FIR_UPDATE_TYPES as readonly string[]).includes(u.update_type)) {
    throw new Error(
      `update_type "${String(u.update_type)}" is invalid — must be one of ${FIR_UPDATE_TYPES.join(", ")}.`
    );
  }
  if (u.status !== undefined && !(FIR_FRAUD_STATUSES as readonly string[]).includes(u.status)) {
    throw new Error(
      `status "${String(u.status)}" is invalid — must be one of ${FIR_FRAUD_STATUSES.join(", ")}.`
    );
  }
  if (u.update_type === "STATUS_CHANGE" && !u.status) {
    throw new Error(
      `update_type=STATUS_CHANGE requires --status (one of ${FIR_FRAUD_STATUSES.join(", ")}).`
    );
  }
}

/** Post a FIR lifecycle UPDATE. Validates then POSTs. Shared by CLI + MCP. */
export async function performFirUpdate(
  client: ReqportClient,
  firId: string,
  body: FirUpdateRequest
): Promise<Record<string, unknown>> {
  validateFirUpdate(body);
  return client.updateFirCase(firId, body);
}

/**
 * Validate a FIR CLOSE body client-side: sender + recipient are required; the
 * nested close payload's reason is required and enum-valid.
 */
export function validateFirClose(body: FirCloseRequest): void {
  if (!body || typeof body !== "object") throw new Error("a close body is required.");
  if (!body.sender) throw new Error("sender is required.");
  if (!body.recipient) throw new Error("recipient is required.");
  const c = body.close;
  if (!c || typeof c !== "object") throw new Error("close is required.");
  if (!c.reason) {
    throw new Error(`reason is required (one of ${FIR_CLOSE_REASONS.join(", ")}).`);
  }
  if (!(FIR_CLOSE_REASONS as readonly string[]).includes(c.reason)) {
    throw new Error(
      `reason "${String(c.reason)}" is invalid — must be one of ${FIR_CLOSE_REASONS.join(", ")}.`
    );
  }
}

/** Close a FIR case with a terminal reason. Validates then POSTs. Shared by CLI + MCP. */
export async function performFirClose(
  client: ReqportClient,
  firId: string,
  body: FirCloseRequest
): Promise<Record<string, unknown>> {
  validateFirClose(body);
  return client.closeFirCase(firId, body);
}

// ── KYC / CDD — Customer Due Diligence response ───────────────────────────────
//
// A single request→response family (NOT a multi-message case). KYC checks are
// KYC_CDD_CHECK_V1 workflow instances; there is no list endpoint, so a responder
// discovers them through the same /v1/affordances discovery the responder loop
// uses. The submit + read-back bodies are snake_case (unlike FIR / the rest).

/** The workflow type of a KYC/CDD check (one request→response family). */
export const KYC_WORKFLOW_TYPE = "KYC_CDD_CHECK_V1";

/**
 * Does this workflow/edge type belong to a KYC/CDD check? Used to filter the
 * shared /v1/affordances discovery down to KYC checks (there is no list
 * endpoint). Kept broad so it matches whether the affordance projection labels
 * the edge as the workflow type (KYC_CDD_CHECK_V1) or a KYC/CDD kernel edge.
 */
export function isKycWorkflowType(t: string | undefined): boolean {
  if (!t) return false;
  const u = t.toUpperCase();
  return u.includes("KYC") || u.includes("CDD");
}

/** The KYC-check affordance groups from a /v1/affordances response. */
export function kycAffordanceGroups(res: AffordanceListResponse): AffordanceGroup[] {
  return (res.groups ?? []).filter((g) => isKycWorkflowType(g.edgeType));
}

function assertEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} "${String(value)}" is invalid — must be one of ${allowed.join(", ")}.`);
  }
}

/**
 * Spot-validate the enum-typed fields of a CDD record client-side before the POST
 * (the server is authoritative; this fails fast on obvious mistakes). Only the
 * fields that carry a fixed vocabulary are checked: kyc_status, risk_rating,
 * pep_status, and relationship.status. All are optional.
 */
export function validateKycRecord(record: CddRecord): void {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("the CDD record must be a JSON object.");
  }
  assertEnum(record.kyc_status, KYC_STATUSES, "kyc_status");
  assertEnum(record.risk_rating, KYC_RISK_RATINGS, "risk_rating");
  assertEnum(record.pep_status, KYC_PEP_STATUSES, "pep_status");
  if (record.relationship) {
    assertEnum(record.relationship.status, KYC_RELATIONSHIP_STATUSES, "relationship.status");
  }
}

export type KycRespondInput = {
  recordStatus: KycRecordStatus;
  /** Optional inline CDD record (snake_case); server-sealed per-party. */
  record?: CddRecord;
  /** Optional pre-sealed content-blind KYC_CDD_JSON document (required when gated). */
  payloadId?: string;
  note?: string;
};

/**
 * Submit a KYC/CDD response. Validates record_status (required + enum) and, when
 * an inline record is given, spot-validates its enums; guards against supplying
 * BOTH an inline record and a payload_id (the server uses the payload_id and
 * ignores the record). Shared by the CLI `qp kyc respond` command and the MCP tool.
 */
export async function performKycRespond(
  client: ReqportClient,
  requestId: string,
  input: KycRespondInput
): Promise<ResponseResult> {
  if (!input.recordStatus) {
    throw new Error("record_status is required (FOUND | NOT_FOUND).");
  }
  if (!(KYC_RECORD_STATUSES as readonly string[]).includes(input.recordStatus)) {
    throw new Error(`record_status "${input.recordStatus}" is invalid — must be one of ${KYC_RECORD_STATUSES.join(", ")}.`);
  }
  if (input.record && input.payloadId) {
    throw new Error(
      "Provide EITHER an inline record OR a pre-sealed payload_id, not both."
    );
  }
  if (input.record) validateKycRecord(input.record);

  const body: KycResponseSubmission = { record_status: input.recordStatus };
  if (input.record) body.record = input.record;
  if (input.payloadId) body.payload_id = input.payloadId;
  if (input.note) body.note = input.note;

  return client.submitKycResponse(requestId, body);
}

/** Read a KYC/CDD response (content-blind read-back). */
export async function readKycResponse(
  client: ReqportClient,
  requestId: string
): Promise<KycResponseView> {
  return client.getKycResponse(requestId);
}
