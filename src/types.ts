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

/**
 * The relationship-type taxonomy a responder MAY attach to a substantive (true)
 * business-relationship answer (server PR #251). Optional but recommended: it
 * lets the requesting authority scope a targeted follow-up (data minimisation).
 * Enum values match the server contract exactly.
 */
export const RELATIONSHIP_TYPES = [
  "CUSTOMER",
  "ACCOUNT_HOLDER",
  "BENEFICIAL_OWNER",
  "AUTHORISED_REPRESENTATIVE",
  "COUNTERPARTY",
  "FORMER_CUSTOMER",
  "OTHER",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** POST /v1/requests/{id}/business-relationship-response body. */
export type BusinessRelationshipAnswer = {
  hasRelationship: boolean;
  payloadId?: string;
  note?: string;
  accounts?: AccountInstrument[];
  /** Optional relationship-type tags; only meaningful on a true answer. */
  relationshipTypes?: RelationshipType[];
};

/**
 * POST /v1/requests/{id}/transaction-history-response body. The camt.053-CA
 * statement is sent INLINE as JSON; Vanta validates it against the
 * CAMT053_CA_JSON schema and seals it server-side (no client crypto).
 */
export type TransactionHistoryAnswer = {
  statement: unknown;
  note?: string;
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

// ── Multi-org chat + attachments ────────────────────────────────────────────

/** The graph target a chat or attachment is anchored to (a node or an edge). */
export type ChatTargetKind = "node" | "edge";
export type ChatTarget = { kind: ChatTargetKind; id: string };

/** A participant org sealed into a chat. */
export type ChatParticipant = {
  namespaceId?: string;
  org: string;
  [k: string]: unknown;
};

/** ChatView — chat metadata (no message bodies). */
export type ChatView = {
  chatId: string;
  kind?: string;
  target: ChatTarget;
  title?: string;
  participants: ChatParticipant[];
  createdAt?: string;
  [k: string]: unknown;
};

/** One message as returned in GET /v1/chats/{id} (caller's decrypted copy). */
export type ChatMessage = {
  messageId: string;
  kind?: string;
  body?: string;
  createdAt?: string;
  [k: string]: unknown;
};

/** GET /v1/chats/{id} */
export type ChatDetail = {
  chat: ChatView;
  messages: ChatMessage[];
};

/** POST /v1/chats/{id}/messages result. */
export type ChatMessageResult = {
  messageId?: string;
  chatId?: string;
  sealedParticipantCount?: number;
  [k: string]: unknown;
};

/** AttachmentView — attachment metadata (no bytes). */
export type AttachmentView = {
  attachmentId: string;
  messageId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  target: ChatTarget;
  participantCount?: number;
  createdAt?: string;
  [k: string]: unknown;
};

/** POST /v1/attachments body (JSON; server seals — no client crypto). */
export type AttachmentCreate = {
  target: ChatTarget;
  filename?: string;
  mimeType?: string;
  contentBase64: string;
  participants?: string[];
};

/** Raw bytes + response metadata from GET /v1/attachments/{id}/download. */
export type AttachmentDownload = {
  bytes: Buffer;
  contentType?: string;
  filename?: string;
};

// ── Pending-approval (human-in-the-loop) ────────────────────────────────────

/**
 * A held response awaiting an approver's decision (server PR #253). Fields are
 * kept loose/forward-compatible; unknown fields are ignored.
 */
export type PendingResponse = {
  id: string;
  requestId?: string;
  responseType?: string;
  /** The auth.002 outcome the held response would carry (e.g. COMP | NFOU). */
  auth002Status?: string;
  createdAt?: string;
  submitter?: string;
  [k: string]: unknown;
};

/**
 * GET /v1/responses/pending. The server may return a bare array or an
 * {items,total} envelope; callers normalise both.
 */
export type PendingListResponse = {
  items?: PendingResponse[];
  total?: number;
  [k: string]: unknown;
};

/** Result of an approve/reject/withdraw action on a held response. */
export type PendingActionResult = {
  id?: string;
  status?: string;
  messageId?: string;
  requestId?: string;
  [k: string]: unknown;
};

/**
 * GET/PUT /v1/responses/approval-policy — which response types require approval
 * before they are sealed + sent. The sentinel "ALL" means every response type.
 */
export type ApprovalPolicy = {
  responseTypes?: string[];
  [k: string]: unknown;
};

// ── FIR — Fraud Incident Response ───────────────────────────────────────────

/**
 * The FIR wire model, mirrored from the Vanta {@code FirWire} Java records.
 *
 * IMPORTANT — wire naming. The whole Vanta API deserializes request bodies with
 * Jackson's DEFAULT strategy (no snake_case override anywhere), so on the WIRE
 * these request bodies are **camelCase** — matching the Java record component
 * names (`transactionRef`, `accountType`, `heldAmount`, `returnTo`, …), exactly
 * like every other endpoint this CLI calls (`hasRelationship`, `docType`,
 * `recipientOrgId`). The *sealed envelope* Vanta assembles server-side is
 * snake_case, but that is output, not the body we send. money.amount is always a
 * decimal STRING, never a number.
 */

/** RESPONSE per-transaction outcome enum (the deterministic HoldAssessment). */
export const FIR_OUTCOMES = ["HELD", "PROCESSED", "PARTIAL", "NEED_INFO"] as const;
export type FirOutcome = (typeof FIR_OUTCOMES)[number];

/**
 * A receiver-side account is ALWAYS pooled / non-personal — its accountType is
 * constrained to this set (a fraudulent payment never lands on a natural person
 * on the receiver side; the victim only appears on the sending-bank side).
 */
export const FIR_RECEIVER_ACCOUNT_TYPES = ["CLIENT_FUNDS", "OMNIBUS", "MERCHANT"] as const;
export type FirReceiverAccountType = (typeof FIR_RECEIVER_ACCOUNT_TYPES)[number];

/** Identifier of a legal entity. Base scheme LEI; overlays add national schemes. */
export type FirEntityIdentifier = { scheme: string; value: string };

/** A financial institution participating in the case. */
export type FirInstitution = {
  identifier: FirEntityIdentifier;
  name?: string;
  team?: string;
  handlerId?: string;
  contact?: string;
};

/** A monetary amount; amount is an exact decimal STRING (never a JSON float). */
export type FirMoney = { amount: string; currency: string };

/** A neutral account / instrument reference. */
export type FirAccount = {
  accountType?: string;
  iban?: string;
  accountNumber?: string;
  maskedPan?: string;
  merchantId?: string;
  merchantName?: string;
  label?: string;
  national?: Record<string, unknown>;
};

/** The receiver-side account a fraudulent payment reached — pooled/non-personal. */
export type FirReceiverAccount = FirAccount & { accountType: string };

/** Card-rail detail, present when rail == CARD. */
export type FirCardDetail = {
  merchantId?: string;
  merchantName?: string;
  authorizationCode?: string;
};

/** One fraudulent inbound payment being reported. */
export type FirTransaction = {
  transactionRef?: string;
  rail?: string;
  amount?: FirMoney;
  executedAt?: string;
  paymentReference?: string;
  sender?: FirAccount;
  receiver?: FirReceiverAccount;
  card?: FirCardDetail;
};

/** A neutral law-enforcement reference (e.g. a police case reference / DNR). */
export type FirLawEnforcementReference = { scheme: string; reference: string };

/** NOTICE payload (sending bank → receiver): report fraud + ask to hold funds. */
export type FirNotice = {
  externalCaseId?: string;
  status?: string;
  fraudType?: string;
  muleTier?: string;
  lawEnforcementReference?: FirLawEnforcementReference;
  requestedAction?: string;
  transactions: FirTransaction[];
  freeText?: string;
};

/** One RESPONSE outcome entry (receiver → bank): per-transaction HoldAssessment. */
export type FirResponseOutcome = {
  transactionRef: string;
  outcome: FirOutcome;
  heldAmount?: FirMoney;
  refundPossible?: boolean;
  infoNeeded?: string[];
  relatedTransactions?: FirTransaction[];
  freeText?: string;
};

/** An abstract, responder-satisfiable refund verification challenge. */
export type FirRefundVerificationChallenge = {
  challengeType?: string;
  description?: string;
  national?: Record<string, unknown>;
};

/** REFUND_INSTRUCTION payload (sending bank → receiver). */
export type FirRefundInstruction = {
  transactionRef: string;
  returnTo: FirAccount;
  returnReferenceText?: string;
  verification?: FirRefundVerificationChallenge;
  confirmationRequested?: boolean;
};

/** POST /v1/fir/cases body — open a case with a NOTICE. */
export type FirCreateNoticeRequest = {
  sender: FirInstitution;
  recipient: FirInstitution;
  recipientOrgId: string;
  notice: FirNotice;
};

/** POST /v1/fir/cases/{firId}/response body — per-transaction outcomes. */
export type FirSubmitResponseRequest = {
  sender: FirInstitution;
  recipient: FirInstitution;
  outcomes: FirResponseOutcome[];
  note?: string;
};

/** POST /v1/fir/cases/{firId}/refund-instruction body. */
export type FirRefundInstructionRequest = {
  sender: FirInstitution;
  recipient: FirInstitution;
  refundInstruction: FirRefundInstruction;
};

/** POST /v1/fir/cases/{firId}/refund-confirmation body (pre-sealed RefundExecution). */
export type FirConfirmRefundRequest = {
  sender: FirInstitution;
  recipient: FirInstitution;
  payloadId: string;
  note?: string;
};

/** POST /v1/fir/cases result — the case id + the assembled NOTICE wire envelope. */
export type FirOpenCaseResult = {
  firId: string;
  status?: string;
  notice?: unknown;
  [k: string]: unknown;
};

/** GET /v1/fir/cases/{firId} — content-blind case metadata. */
export type FirCaseView = {
  firId: string;
  workflowType?: string;
  status?: string;
  responseOutcome?: string;
  requesterOrgId?: string;
  responderOrgId?: string;
  createdAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
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
