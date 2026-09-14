/**
 * Shared responder logic used by BOTH the CLI commands and the MCP tools, so
 * the two surfaces behave identically. No console output here — callers render.
 */

import { ReqportApiError, ReqportClient } from "./client.js";
import {
  RELATIONSHIP_TYPES,
  type AccountInstrument,
  type ChatTarget,
  type DecodedPayload,
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
