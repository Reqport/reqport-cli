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

/**
 * GET /v1/workflows/requests — the unified requests-list projection the portal
 * workspace list also reads. Server-resolves the display-ready fields
 * (counterpartyName, typeDescriptor, statusPhase) so every surface renders the
 * same values instead of re-deriving them. Only the fields the CLI renders are
 * typed here; the projection carries more (index signature keeps it forgiving).
 */
export type ListRequestTypeDescriptor = {
  label: string;
  family: "authority" | "structured" | "free-text" | "unknown";
};
export type ListRequestItem = {
  workflowId: string;
  requestType: string;
  createdAt?: string | null;
  direction?: "OUTGOING" | "INCOMING";
  status: string;
  /** Server-resolved counterparty display name (public directory); null when unresolved. */
  counterpartyName?: string | null;
  counterpartyOrgId?: string | null;
  /** Server-resolved requester/submitter display name (public directory); null when unresolved. */
  requesterName?: string | null;
  requesterOrgId?: string | null;
  /** Server-resolved {label, family} type descriptor. */
  typeDescriptor?: ListRequestTypeDescriptor | null;
  /** Server-resolved product phase: "new" | "in_progress" | "responded" (+ reserved). */
  statusPhase?: string | null;
  invstgtnId?: string | null;
  diarienummer?: string | null;
  requestNumber?: string | null;
  deadline?: string | null;
  lastActivityAt?: string | null;
  [k: string]: unknown;
};
export type ListRequestsResponse = {
  items: ListRequestItem[];
};

/**
 * GET /v1/workflows/{workflowInstanceId}/view — the server-assembled request
 * VIEW (mirrors the Vanta `RequestView` DTO). Where `/v1/workflows/{id}` hands
 * back the raw workflow row and the payload must be decrypted client-side, the
 * `/view` endpoint decrypts the caller's own copy in the TEE and projects the
 * request onto a uniform list of typed {@link RequestViewSection sections}, so
 * the CLI (like the portal) can be a thin renderer that walks `sections[]` and
 * draws each `kind`. A section is present only when it has content. The shape is
 * additive/forward-compatible — unknown section kinds and fields are ignored.
 */
export type RequestViewParty = { orgId: string; name?: string | null };
export type RequestViewIdentity = {
  /** Requester's case / investigation id (invstgtnId / diarienummer), or null when undecryptable. */
  caseNumber?: string | null;
  title?: string | null;
  /** Raw workflow status: SENT | RESPONDED | CLOSED. */
  status?: string | null;
  /** Normalized lifecycle bucket: OPEN | ANSWERED | CLOSED | PENDING_APPROVAL | DECLINED. */
  statusKind?: string | null;
};
export type RequestViewParties = {
  requester?: RequestViewParty | null;
  responder?: RequestViewParty | null;
  /** The caller's role in this request: REQUESTER | RESPONDER. */
  role?: string | null;
};
export type RequestViewCapabilities = {
  canRespond?: boolean;
  canMessage?: boolean;
  canClaim?: boolean;
};

/** overview: ordered scalar label/value fields. */
export type OverviewField = { label?: string | null; value?: string | null };
export type OverviewData = { fields?: OverviewField[] };

/** parties: the subjects the request is about (persons / organisations / instruments). */
export type PartySubject = {
  /** PERSON | ORGANISATION | INSTRUMENT | OTHER. */
  kind?: string | null;
  label?: string | null;
  identifier?: string | null;
  scheme?: string | null;
};
export type PartiesSectionData = { subjects?: PartySubject[] };

/** legalBasis: the legal mandate(s) the requester asserts. */
export type LegalBasisData = { bases?: string[] };

/** requestBody: the free-text ask, decrypted for the caller. */
export type RequestBodyData = { prose?: string | null };

/** answer: the responder's answer, when the request has been answered. */
export type AnswerAccount = {
  instrumentType?: string | null;
  identifier?: string | null;
  scheme?: string | null;
  label?: string | null;
  chain?: string | null;
};
export type AnswerData = {
  /** auth.002 outcome carried on the workflow row: NORMAL | NFOU | null. */
  outcome?: string | null;
  hasRelationship?: boolean | null;
  relationshipTypes?: string[];
  accounts?: AnswerAccount[];
  note?: string | null;
};

/** attachments: a content-blind manifest (no bytes; references only). */
export type AttachmentManifestEntry = {
  payloadId?: string | null;
  /** OUTBOUND | INBOUND | null. */
  direction?: string | null;
  at?: string | null;
};
export type AttachmentsData = { entries?: AttachmentManifestEntry[] };

/** timeline: the ordered thread of events visible to the caller. */
export type TimelineEvent = {
  /** REQUEST_BODY / RESPONSE_BODY / REQUESTER_MESSAGE_BODY / ATTACHMENT / … */
  type?: string | null;
  /** OUTBOUND | INBOUND | null. */
  direction?: string | null;
  at?: string | null;
};
export type TimelineData = { events?: TimelineEvent[] };

/** A uniform, render-ready section. `data` shape depends on `kind`. */
export type RequestViewSection = { kind: string; data: unknown };

export type RequestView = {
  /** Always 1; bumped on breaking shape changes. */
  apiVersion?: number;
  id: string;
  /** Raw workflow type (e.g. BUSINESS_RELATIONSHIP_CHECK_V1). */
  type?: string | null;
  identity?: RequestViewIdentity | null;
  parties?: RequestViewParties | null;
  capabilities?: RequestViewCapabilities | null;
  /** The render-ready typed sections, in display order. */
  sections?: RequestViewSection[];
  [k: string]: unknown;
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

// ── Create (requester / authority side — identifier-first, no BR check) ─────

/**
 * POST /v1/requests/transaction-history body. The authority already holds the
 * instrument and asks a known-holder responder directly. Exactly one responder
 * locator (responderOrgId | responderDomain); identifier + from/to required.
 */
export type DirectTransactionHistoryRequest = {
  responderOrgId?: string;
  responderDomain?: string;
  instrumentType?: string; // default WALLET
  identifier: string; // the wallet/account the authority already has
  scheme?: string; // e.g. BITCOIN / ETHEREUM / IBAN
  from: string; // inclusive start, yyyy-mm-dd
  to: string; // inclusive end, yyyy-mm-dd
  invstgtnId: string;
  legalBasis: string;
  message?: string;
  subjectPersonnummer?: string;
  subjectOrgNr?: string;
};

/** POST /v1/requests/kyc body. Exactly one responder locator + one subject. */
export type DirectKycRequest = {
  responderOrgId?: string;
  responderDomain?: string;
  subjectPersonnummer?: string;
  subjectOrgNr?: string;
  invstgtnId: string;
  legalBasis: string;
  message?: string;
};

/**
 * POST /v1/requests/information body — a free-text (unstructured) information
 * request. Exactly one responder locator; `request` (the free-text ask),
 * invstgtnId, and legalBasis required. Optional subject is sealed.
 */
export type DirectInformationRequest = {
  responderOrgId?: string;
  responderDomain?: string;
  request: string; // the free-text ask
  invstgtnId: string;
  legalBasis: string;
  subjectPersonnummer?: string;
  subjectOrgNr?: string;
};

/** Result shape from the direct-create endpoints. */
export type DirectCreateResult = {
  requestId?: string;
  workflowType?: string;
  status?: string;
  requesterOrgId?: string;
  responderOrgId?: string;
  createdAt?: string;
  [k: string]: unknown;
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

// ── Org states (a requestor's verifiable status) + requestor-status rulesets ──

/**
 * A requestor org's verifiable status, from the consortium oracles
 * (GET /v1/orgs/{orgId}/states, scope reference:read). What a responder keys
 * auto-approve/hold rules on.
 */
export type OrgStates = {
  orgId: string;
  isAuthority: boolean;
  lawEnforcementAgency?: boolean | null;
  isRegulatedFi: boolean;
  regulatoryClasses?: string[];
  country?: string | null;
  status?: string | null;
  [k: string]: unknown;
};

/** What a ruleset action does when its predicate matches the requestor. */
export type RulesetAction = "AUTO_RELEASE" | "HOLD_FOR_APPROVAL" | "DECLINE";

/**
 * Match on the requestor's states. All present conditions must hold (AND); an
 * empty predicate {} matches every requestor (a catch-all).
 */
export type RulesetPredicate = {
  isAuthority?: boolean | null;
  lawEnforcementAgency?: boolean | null;
  isRegulatedFi?: boolean | null;
  country?: string | null;
  regulatoryClass?: string | null;
  regulatoryClasses?: string[] | null;
  /**
   * Which response/data types this rule applies to (empty/absent = ALL types).
   * Slugs (vanta responseGatingSlug): business-relationship-check | transaction-history
   * | kyc | information. Lets a rule say "auto-release BR checks from verified LEA
   * but hold transaction-history".
   */
  responseTypes?: string[] | null;
};

/** One rule as read back (ordinal assigned by the server) or submitted (ordinal ignored). */
export type RulesetRule = {
  ordinal?: number;
  predicate: RulesetPredicate;
  action: RulesetAction;
};

export type RequestorRuleset = {
  rules: RulesetRule[];
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

// ── FIR identity-exchange (identity-request / identity-response) ──────────────
//
// Two later messages on a FIR case: a party asks for the identity behind a
// fraud-transaction counterparty (identity-request), and the counterparty
// returns the KYC/IVMS101 identity core (identity-response). Like the rest of
// FIR, these bodies are camelCase on the wire (Jackson default). The identity
// subject is the same natural/legal-person core as KYC/CDD, but camelCase here.

/** Which counterparty the identity is about (relative to the fraud transaction). */
export const FIR_ABOUT_PARTIES = ["ORDER_CUSTOMER", "ORIGINATOR"] as const;
export type FirAboutParty = (typeof FIR_ABOUT_PARTIES)[number];

/** identity-response record status (FOUND → auth.002 COMP; NOT_FOUND → NFOU). */
export const FIR_IDENTITY_RECORD_STATUSES = ["FOUND", "NOT_FOUND"] as const;
export type FirIdentityRecordStatus = (typeof FIR_IDENTITY_RECORD_STATUSES)[number];

/**
 * The legal basis for an identity request. At least one field must be present
 * (server gate mirrored client-side): a policy token, or a {scheme, reference}
 * citation, or a free-text description.
 */
export type FirLegalBasis = {
  token?: string;
  scheme?: string;
  reference?: string;
  description?: string;
};

/** A scheme-qualified identifier {scheme, value} (camelCase FIR variant). */
export type FirIdentitySchemeValue = { scheme?: string; value?: string };

/** IVMS101-aligned natural-person name: primary (family) + optional secondary (given). */
export type FirNaturalPersonName = { primary?: string; secondary?: string };

/**
 * A postal address on an identity subject (camelCase). Kept loose/forward-
 * compatible — the exact component names are not pinned by the contract note.
 */
export type FirIdentityAddress = {
  addressLine?: string[];
  postCode?: string;
  townName?: string;
  country?: string;
  [k: string]: unknown;
};

/** IVMS101-aligned natural-person identity core (camelCase). */
export type FirNaturalPerson = {
  name?: FirNaturalPersonName;
  dateOfBirth?: string;
  placeOfBirth?: string;
  nationality?: string;
  residenceAddress?: FirIdentityAddress;
  nationalIdentifier?: FirIdentitySchemeValue;
  customerId?: string;
};

/** IVMS101-aligned legal-person identity core (camelCase). */
export type FirLegalPerson = {
  name?: string;
  legalEntityIdentifier?: string;
  nationalRegistration?: FirIdentitySchemeValue;
  registrationCountry?: string;
  incorporationDate?: string;
  registrationAddress?: FirIdentityAddress;
};

/** The identity subject — a natural person OR a legal person (camelCase). */
export type FirIdentitySubject = {
  naturalPerson?: FirNaturalPerson;
  legalPerson?: FirLegalPerson;
};

/** IdentityRequest payload — ask for the identity behind a fraud counterparty. */
export type FirIdentityRequest = {
  transactionRef: string;
  aboutParty: FirAboutParty;
  legalBasis: FirLegalBasis;
  paymentReference?: string;
  requestedAttributes?: string[];
  freeText?: string;
};

/** IdentityResponse payload — return (or decline) the counterparty's identity. */
export type FirIdentityResponse = {
  transactionRef: string;
  recordStatus: FirIdentityRecordStatus;
  aboutParty?: FirAboutParty;
  subject?: FirIdentitySubject;
  freeText?: string;
};

/** POST /v1/fir/cases/{firId}/identity-request body. */
export type FirIdentityRequestRequest = {
  sender: FirInstitution;
  recipient: FirInstitution;
  identityRequest: FirIdentityRequest;
};

/**
 * POST /v1/fir/cases/{firId}/identity-response body. The subject is supplied
 * EITHER inline under identityResponse.subject OR as a pre-sealed content-blind
 * payloadId (REQUIRED when the responder gates identity disclosure) — not both.
 */
export type FirIdentityResponseRequest = {
  sender: FirInstitution;
  recipient: FirInstitution;
  identityResponse: FirIdentityResponse;
  payloadId?: string;
  note?: string;
};

// ── FIR lifecycle (update / close) ────────────────────────────────────────────
//
// Two lifecycle messages on an open FIR case: post an UPDATE (correction, added
// law-enforcement reference, extra transactions, a fraud-status change, or a
// question/answer), and CLOSE the case with a terminal reason.
//
// Like every other FIR write, the request body carries the two institutions
// (sender/recipient — descriptive Institution objects sealed into the envelope;
// vanta authorizes on the authenticated caller, not on body.sender) plus a NESTED
// payload — here under `update` / `close`. The PAYLOAD fields are **snake_case**
// on the wire (update_type, law_enforcement_reference, free_text, reason) matching
// the vanta DTO. Enums are validated client-side.

/** UPDATE update_type enum — the kind of lifecycle update being posted. */
export const FIR_UPDATE_TYPES = [
  "CORRECTION",
  "LAW_ENFORCEMENT_REFERENCE_ADDED",
  "ADDITIONAL_TRANSACTIONS",
  "STATUS_CHANGE",
  "QUESTION",
  "ANSWER",
] as const;
export type FirUpdateType = (typeof FIR_UPDATE_TYPES)[number];

/** The fraud status carried by a STATUS_CHANGE update (only meaningful there). */
export const FIR_FRAUD_STATUSES = [
  "SUSPECTED",
  "STRONG_SUSPICION",
  "CONFIRMED",
  "CLEARED",
] as const;
export type FirFraudStatus = (typeof FIR_FRAUD_STATUSES)[number];

/** CLOSE reason enum — the terminal outcome of the case. */
export const FIR_CLOSE_REASONS = [
  "REFUNDED",
  "NOT_RECOVERABLE",
  "NO_MATCH",
  "WITHDRAWN",
  "OTHER",
] as const;
export type FirCloseReason = (typeof FIR_CLOSE_REASONS)[number];

/**
 * UPDATE payload (snake_case) — nested under `update` in the request body.
 * update_type is mandatory; law_enforcement_reference / status / transactions /
 * free_text are optional. `status` is only meaningful with
 * update_type=STATUS_CHANGE. `transactions` (for ADDITIONAL_TRANSACTIONS) is
 * passed through verbatim from the caller's JSON — the contract pins only these
 * keys, so its element shape is not re-cast here.
 */
export type FirUpdate = {
  update_type: FirUpdateType;
  law_enforcement_reference?: FirLawEnforcementReference;
  status?: FirFraudStatus;
  transactions?: unknown[];
  free_text?: string;
};

/** POST /v1/fir/cases/{firId}/update body — parties + the nested UPDATE payload. */
export type FirUpdateRequest = {
  sender: FirInstitution;
  recipient: FirInstitution;
  update: FirUpdate;
};

/** CLOSE payload (snake_case) — nested under `close` in the request body. reason is mandatory. */
export type FirClose = {
  reason: FirCloseReason;
  free_text?: string;
};

/** POST /v1/fir/cases/{firId}/close body — parties + the nested CLOSE payload. */
export type FirCloseRequest = {
  sender: FirInstitution;
  recipient: FirInstitution;
  close: FirClose;
};

// ── KYC / CDD — Customer Due Diligence response ──────────────────────────────
//
// IMPORTANT — wire naming. UNLIKE the rest of this CLI (and unlike FIR, which is
// camelCase), the KYC/CDD bodies are **snake_case** on the wire: the Vanta
// KycResponseController's DTO records are NAMED in snake_case (record_status,
// payload_id, natural_person, kyc_status, risk_rating, national_identifier,
// beneficial_owners, source_of_funds, …) so Jackson's default mapping emits the
// IWDX kyc/v0.1 schema keys with no @JsonProperty. Build every KYC body
// snake_case. All record fields are optional; only record_status is mandatory.

/** The mandatory record_status enum (FOUND → auth.002 COMP; NOT_FOUND → NFOU). */
export const KYC_RECORD_STATUSES = ["FOUND", "NOT_FOUND"] as const;
export type KycRecordStatus = (typeof KYC_RECORD_STATUSES)[number];

/** kyc_status enum. */
export const KYC_STATUSES = ["VERIFIED", "PENDING", "REJECTED", "EXPIRED"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

/** risk_rating enum. */
export const KYC_RISK_RATINGS = ["LOW", "MEDIUM", "HIGH"] as const;
export type KycRiskRating = (typeof KYC_RISK_RATINGS)[number];

/** pep_status enum (not a PEP / a PEP / a relative or close associate). */
export const KYC_PEP_STATUSES = ["NONE", "PEP", "RCA"] as const;
export type KycPepStatus = (typeof KYC_PEP_STATUSES)[number];

/** relationship.status enum. */
export const KYC_RELATIONSHIP_STATUSES = ["ACTIVE", "CLOSED", "DORMANT"] as const;
export type KycRelationshipStatus = (typeof KYC_RELATIONSHIP_STATUSES)[number];

/** A scheme-qualified identifier: the {scheme, value} pair. */
export type KycSchemeValue = { scheme?: string; value?: string };

/** A postal address; only the country code is constrained (ISO 3166-1 alpha-2). */
export type KycAddress = {
  address_line?: string[];
  post_code?: string;
  town_name?: string;
  country?: string;
};

/** IVMS101-aligned natural-person name: primary (family) + optional secondary (given). */
export type KycNameNatural = { primary?: string; secondary?: string };

/** IVMS101-aligned natural-person identity core. */
export type KycNaturalPerson = {
  name?: KycNameNatural;
  date_of_birth?: string;
  place_of_birth?: string;
  nationality?: string;
  residence_address?: KycAddress;
  national_identifier?: KycSchemeValue;
  customer_id?: string;
};

/** IVMS101-aligned legal-person identity core. */
export type KycLegalPerson = {
  name?: string;
  legal_entity_identifier?: string;
  national_registration?: KycSchemeValue;
  registration_country?: string;
  incorporation_date?: string;
  registration_address?: KycAddress;
};

/** The customer identity — exactly one of a natural person OR a legal person. */
export type KycSubject = {
  natural_person?: KycNaturalPerson;
  legal_person?: KycLegalPerson;
};

/** How and to what depth the customer's identity was verified. */
export type KycVerification = {
  method?: string;
  level?: string;
  verified_at?: string;
  provider?: string;
};

/** Sanctions / adverse-media screening outcome. */
export type KycScreening = {
  sanctions_hit?: boolean;
  adverse_media?: boolean;
  screened_at?: string;
  provider?: string;
};

/** For a legal person: a beneficial owner / controller (itself a natural person). */
export type KycBeneficialOwner = {
  person?: KycNaturalPerson;
  ownership_percent?: number;
  control_type?: string;
};

/** A code and/or human-readable description (source_of_funds / source_of_wealth). */
export type KycCodedDescription = { code?: string; description?: string };

/** The business relationship's current shape and review cadence. */
export type KycRelationship = {
  type?: string;
  status?: KycRelationshipStatus;
  onboarded_at?: string;
  last_reviewed_at?: string;
  next_review_due?: string;
  products?: string[];
};

/**
 * The CDD record — the IWDX kyc/v0.1 CddResponse minus record_status (the
 * submission carries that at the top level). Identity core + assessment layer.
 * Every field is optional; the responder discloses only what is sufficient
 * (data minimisation). ALL keys are snake_case.
 */
export type CddRecord = {
  subject?: KycSubject;
  verification?: KycVerification;
  kyc_status?: KycStatus;
  risk_rating?: KycRiskRating;
  risk_factors?: string[];
  pep_status?: KycPepStatus;
  pep_position?: string;
  screening?: KycScreening;
  beneficial_owners?: KycBeneficialOwner[];
  source_of_funds?: KycCodedDescription;
  source_of_wealth?: KycCodedDescription;
  relationship?: KycRelationship;
  queried_at?: string;
};

/**
 * POST /v1/requests/{requestId}/kyc-response body. record_status is mandatory;
 * supply the record EITHER inline under `record` (server-sealed per-party) OR as
 * a pre-sealed content-blind `payload_id` (a KYC_CDD_JSON document; REQUIRED when
 * the responder's approval policy gates KYC — no cleartext PII may be held).
 */
export type KycResponseSubmission = {
  record_status: KycRecordStatus;
  record?: CddRecord;
  payload_id?: string;
  note?: string;
};

/**
 * GET /v1/requests/{requestId}/kyc-response — content-blind read-back. Snake_case
 * (mirrors the KycResponseView Java record). record_status is null until answered.
 */
export type KycResponseView = {
  request_id: string;
  record_status?: string | null;
  workflow_status?: string | null;
  requester_org_id?: string | null;
  responder_org_id?: string | null;
  responded_at?: string | null;
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
