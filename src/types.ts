/**
 * Wire types mirrored from the Vanta OpenAPI / controllers. Kept intentionally
 * loose (optional fields, forward-compatible) — the contract is additive and
 * clients MUST ignore unknown fields.
 */

/** GET /v1/attestation */
export type AttestationResponse = {
  maaToken?: string;
  token?: string;
  nonce?: string;
  vantaPublicKeyThumbprint?: string;
  [k: string]: unknown;
};

/** GET /v1/affordances and /v1/affordances/mine */
export type AffordanceItem = {
  id: string;
  workflowInstanceId: string;
  namespaceId?: string;
  edgeType: string;
  edgeState: string;
  createdAt: string;
};
export type AffordanceGroup = {
  edgeType: string;
  count: number;
  items: AffordanceItem[];
};
export type AffordanceListResponse = {
  total: number;
  groups: AffordanceGroup[];
};

/** GET /v1/workflows/{id} */
export type WorkflowInstanceResponse = {
  workflowInstanceId: string;
  workflowType: string;
  workflowVersion?: number;
  status: string;
  requesterOrgId?: string;
  responderOrgId?: string;
  namespaceId?: string;
  callerPartySlot?: string;
  callerIsResponder?: boolean;
  responseOutcome?: string;
  relatesToWorkflowInstanceId?: string;
  createdAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
};

/** GET /v1/workflows/{id}/request-payload | /response-payload */
export type PayloadMetaResponse = {
  payloadId: string;
  recipientOrgId?: string;
  senderOrgId?: string;
  workflowInstanceId?: string;
  messageType?: string;
  providerId?: string;
  providerRef?: string;
  envelopeId?: string;
  contentType?: string;
  sizeBytes?: number;
  createdAt?: string;
  [k: string]: unknown;
};

/** POST /v1/payloads/decrypt-batch */
export type DecryptBatchItem = {
  payloadId: string;
  ok: boolean;
  contentType?: string | null;
  plaintextBase64?: string | null;
  errorCode?: string | null;
};
export type DecryptBatchResponse = { items: DecryptBatchItem[] };

/** A typed instrument disclosed with a substantive (COMP) answer. */
export type AccountInstrument = {
  instrumentType: "ACCOUNT" | "WALLET" | "CARD";
  identifier: string;
  scheme?: string;
  label?: string;
};

/** POST /v1/requests/{id}/business-relationship-response body. */
export type BusinessRelationshipAnswer = {
  hasRelationship: boolean;
  payloadId?: string;
  note?: string;
  accounts?: AccountInstrument[];
};

/** POST /v1/requests/{id}/response body (the generic responder path). */
export type ResponseItem = {
  category?: number;
  mode: "structured" | "unstructured";
  document?: {
    docType: string;
    payloadId?: string;
    providerId?: string;
    providerRef?: string;
    mimeType?: string;
    filename?: string;
    size?: number;
    integrityHash?: string;
  };
  freeText?: string;
};
export type ResponseSubmission = {
  status: "COMP" | "NFOU";
  items: ResponseItem[];
  note?: string;
  accounts?: AccountInstrument[];
};

/** Shared result shape from both responder endpoints. */
export type ResponseResult = {
  messageId?: string;
  requestId?: string;
  status?: string;
  itemCount?: number;
  createdAt?: string;
  [k: string]: unknown;
};

/** POST /v1/orgs/me/api-keys request. */
export type CreateApiKeyRequest = {
  displayName: string;
  scopes?: string[];
  expiresInDays?: number;
};

/** POST /v1/orgs/me/api-keys response — apiKey cleartext is shown ONCE. */
export type CreateApiKeyResponse = {
  keyId: string;
  apiKey: string;
  displayName: string;
  scopes: string[];
  createdAt?: string;
  expiresAt?: string;
};

/** GET /v1/orgs/me/api-keys item (metadata only). */
export type ApiKeyInfo = {
  keyId: string;
  displayName: string;
  scopes: string[];
  createdAt?: string;
  revokedAt?: string;
  expiresAt?: string;
};

/** A decoded request payload plus the resolved plaintext. */
export type DecodedPayload = {
  payloadId: string;
  ok: boolean;
  contentType?: string | null;
  /** Decoded UTF-8 text (from plaintextBase64), when ok. */
  text?: string;
  /** Parsed JSON when the text parses, else undefined. */
  json?: unknown;
  errorCode?: string | null;
};
