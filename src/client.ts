/**
 * ReqportClient — a thin HTTP client over the Vanta responder + key-management
 * API.
 *
 * Spike finding (see README / SKILL): the responder loop is SERVER-ASSISTED.
 * Reads (`decrypt-batch`) return plaintext decrypted inside the TEE, and the
 * business-relationship answer is sealed server-side. So this client is pure
 * HTTP + a bearer credential — no Model-1 dual-JWE, device key, or DPoP.
 *
 * A credential is either an `rqk_live_` API key (MACHINE) or a Signicat user
 * JWT (HUMAN, from `qp login`). Both go on the wire as `Authorization: Bearer`.
 * Key management (create/list/revoke) requires the JWT — an API key cannot mint
 * keys.
 *
 * Uses the Node 18+ global `fetch` (no HTTP dependency). Never logs the secret.
 */

import { randomUUID } from "node:crypto";
import { baseUrlFor, type ReqportEnv } from "./env.js";
import type {
  AffordanceListResponse,
  AttachmentCreate,
  AttachmentDownload,
  AttachmentView,
  AttestationResponse,
  ApprovalPolicy,
  BusinessRelationshipAnswer,
  ChatDetail,
  ChatMessageResult,
  ChatTarget,
  ChatView,
  DecryptBatchResponse,
  FirCaseView,
  FirConfirmRefundRequest,
  FirCreateNoticeRequest,
  FirOpenCaseResult,
  FirRefundInstructionRequest,
  FirSubmitResponseRequest,
  PayloadMetaResponse,
  PendingActionResult,
  PendingListResponse,
  PendingResponse,
  ResponseResult,
  ResponseSubmission,
  TransactionHistoryAnswer,
  WorkflowInstanceResponse,
} from "./types.js";

/** A resolved bearer credential (an rqk_live_ API key under the pairing model). */
export type Credential = {
  value: string;
  kind: "apikey";
};

export type ReqportClientOptions = {
  env: ReqportEnv;
  /** Bearer credential. Optional: attestation is (nominally) unauthenticated. */
  credential?: Credential;
};

/** A structured API error carrying the HTTP status and any server error body. */
export class ReqportApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly path: string;
  constructor(status: number, path: string, body: string, message?: string) {
    super(message ?? `Vanta ${status} on ${path}${body ? `: ${body}` : ""}`);
    this.name = "ReqportApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class ReqportClient {
  readonly env: ReqportEnv;
  readonly baseUrl: string;
  private readonly credential?: Credential;

  constructor(opts: ReqportClientOptions) {
    this.env = opts.env;
    this.baseUrl = baseUrlFor(opts.env);
    this.credential = opts.credential;
  }

  get hasCredential(): boolean {
    return Boolean(this.credential);
  }
  get credentialKind(): Credential["kind"] | undefined {
    return this.credential?.kind;
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async request<T>(
    path: string,
    init: RequestInit & {
      auth?: boolean;
      idempotent?: boolean;
    } = {}
  ): Promise<T> {
    const { auth = true, idempotent = false, headers, ...rest } = init;
    const h: Record<string, string> = {
      Accept: "application/json",
      ...(headers as Record<string, string> | undefined),
    };
    if (rest.body !== undefined) h["Content-Type"] = "application/json";
    if (auth) {
      if (!this.credential) {
        throw new Error(
          "This operation requires authentication. Set REQPORT_API_KEY or run `qp login`."
        );
      }
      h["Authorization"] = `Bearer ${this.credential.value}`;
    }
    if (idempotent) h["Idempotency-Key"] = randomUUID();

    let res: Response;
    try {
      res = await fetch(this.url(path), { ...rest, headers: h });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Network error calling ${this.url(path)}: ${msg}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ReqportApiError(res.status, path, body);
    }
    if (res.status === 204) return undefined as unknown as T;
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }

  /**
   * Like {@link request}, but returns the raw response body as a Buffer instead
   * of parsing JSON (for binary downloads). Also surfaces the Content-Type and
   * the Content-Disposition filename so callers can name the saved file.
   */
  private async requestBytes(
    path: string,
    init: RequestInit & { auth?: boolean } = {}
  ): Promise<{ bytes: Buffer; contentType?: string; filename?: string }> {
    const { auth = true, headers, ...rest } = init;
    const h: Record<string, string> = {
      Accept: "application/octet-stream",
      ...(headers as Record<string, string> | undefined),
    };
    if (auth) {
      if (!this.credential) {
        throw new Error(
          "This operation requires authentication. Set REQPORT_API_KEY or run `qp login`."
        );
      }
      h["Authorization"] = `Bearer ${this.credential.value}`;
    }

    let res: Response;
    try {
      res = await fetch(this.url(path), { ...rest, headers: h });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Network error calling ${this.url(path)}: ${msg}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ReqportApiError(res.status, path, body);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? undefined;
    const disposition = res.headers.get("content-disposition") ?? undefined;
    return { bytes, contentType, filename: filenameFromDisposition(disposition) };
  }

  // ── Unauthenticated ──────────────────────────────────────────────────────

  /**
   * GET /v1/attestation — MAA hardware-attestation evidence. Documented as
   * public, but sandbox's Spring Security chain currently gates it behind a
   * Bearer token (WWW-Authenticate: Bearer), so we attach the credential when
   * present. The endpoint ignores auth where it is truly public, so sending it
   * is safe.
   */
  attestation(nonce?: string): Promise<AttestationResponse> {
    const q = nonce ? `?nonce=${encodeURIComponent(nonce)}` : "";
    return this.request<AttestationResponse>(`/v1/attestation${q}`, {
      method: "GET",
      auth: this.hasCredential,
    });
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  /**
   * GET /v1/affordances — open traversals addressed to the caller's org
   * (responder discovery). `mine: true` switches to /v1/affordances/mine.
   */
  listAffordances(params?: {
    state?: string;
    edgeType?: string;
    mine?: boolean;
  }): Promise<AffordanceListResponse> {
    const q = new URLSearchParams();
    if (params?.state) q.set("state", params.state);
    if (params?.edgeType) q.set("edge_type", params.edgeType);
    const suffix = params?.mine ? "/mine" : "";
    const query = q.toString() ? `?${q.toString()}` : "";
    return this.request<AffordanceListResponse>(
      `/v1/affordances${suffix}${query}`,
      { method: "GET" }
    );
  }

  // ── Request detail ───────────────────────────────────────────────────────

  getWorkflow(id: string): Promise<WorkflowInstanceResponse> {
    return this.request<WorkflowInstanceResponse>(
      `/v1/workflows/${encodeURIComponent(id)}`,
      { method: "GET" }
    );
  }

  getRequestPayload(id: string): Promise<PayloadMetaResponse> {
    return this.request<PayloadMetaResponse>(
      `/v1/workflows/${encodeURIComponent(id)}/request-payload`,
      { method: "GET" }
    );
  }

  getResponsePayload(id: string): Promise<PayloadMetaResponse> {
    return this.request<PayloadMetaResponse>(
      `/v1/workflows/${encodeURIComponent(id)}/response-payload`,
      { method: "GET" }
    );
  }

  // ── Read (server-assisted decrypt in the TEE) ──────────────────────────────

  /**
   * POST /v1/payloads/decrypt-batch — the TEE mints a capability, downloads the
   * ciphertext, decrypts it, and returns base64 plaintext to an authorized
   * caller (scope payloads:read). Max 20 payloadIds per call.
   */
  decryptBatch(payloadIds: string[]): Promise<DecryptBatchResponse> {
    if (payloadIds.length === 0) return Promise.resolve({ items: [] });
    if (payloadIds.length > 20) {
      throw new Error("decrypt-batch accepts at most 20 payloadIds per call.");
    }
    return this.request<DecryptBatchResponse>(`/v1/payloads/decrypt-batch`, {
      method: "POST",
      body: JSON.stringify({ payloadIds }),
    });
  }

  // ── Answer ─────────────────────────────────────────────────────────────

  /**
   * POST /v1/requests/{id}/business-relationship-response — the purpose-built
   * Engagemangskontroll answer. false → auth.002 NFOU (no payload). true →
   * auth.002 COMP with inline typed accounts (sealed server-side in the TEE) or
   * a pre-sealed payloadId. Scope responses:write; caller org must be the
   * request's responder org.
   */
  submitBusinessRelationshipResponse(
    id: string,
    answer: BusinessRelationshipAnswer
  ): Promise<ResponseResult> {
    return this.request<ResponseResult>(
      `/v1/requests/${encodeURIComponent(id)}/business-relationship-response`,
      { method: "POST", idempotent: true, body: JSON.stringify(answer) }
    );
  }

  /**
   * POST /v1/requests/{id}/response — the generic responder answer. COMP with
   * items/accounts or NFOU. A structured sealed-document item requires a
   * pre-uploaded payloadId (client-side encryption; not performed by this thin
   * CLI). Free-text and inline-account answers need no client crypto.
   */
  submitResponse(
    id: string,
    submission: ResponseSubmission
  ): Promise<ResponseResult> {
    return this.request<ResponseResult>(
      `/v1/requests/${encodeURIComponent(id)}/response`,
      { method: "POST", idempotent: true, body: JSON.stringify(submission) }
    );
  }

  /**
   * POST /v1/requests/{id}/transaction-history-response — the crypto
   * transaction-history answer. The camt.053-CA statement is sent INLINE as
   * JSON; Vanta validates it against the CAMT053_CA_JSON schema and seals it
   * server-side in the TEE (no client crypto), exactly like the
   * business-relationship account disclosure. Scope responses:write; caller org
   * must be the request's responder org.
   */
  submitTransactionHistoryResponse(
    id: string,
    answer: TransactionHistoryAnswer
  ): Promise<ResponseResult> {
    return this.request<ResponseResult>(
      `/v1/requests/${encodeURIComponent(id)}/transaction-history-response`,
      { method: "POST", idempotent: true, body: JSON.stringify(answer) }
    );
  }

  // ── Pending-approval (human-in-the-loop) ──────────────────────────────────

  /**
   * GET /v1/responses/pending — this org's held responses awaiting an approver's
   * decision (scope responses:read). Returns either a bare array or an
   * {items,total} envelope; callers normalise both.
   */
  listPendingResponses(): Promise<PendingListResponse | PendingResponse[]> {
    return this.request<PendingListResponse | PendingResponse[]>(
      `/v1/responses/pending`,
      { method: "GET" }
    );
  }

  /**
   * POST /v1/responses/pending/{id}/approve — release a held response; the seal
   * + send happens server-side (scope responses:write).
   */
  approvePendingResponse(id: string): Promise<PendingActionResult> {
    return this.request<PendingActionResult>(
      `/v1/responses/pending/${encodeURIComponent(id)}/approve`,
      { method: "POST", idempotent: true }
    );
  }

  /**
   * POST /v1/responses/pending/{id}/reject — reject a held response, optionally
   * with a reason (scope responses:write).
   */
  rejectPendingResponse(id: string, reason?: string): Promise<PendingActionResult> {
    return this.request<PendingActionResult>(
      `/v1/responses/pending/${encodeURIComponent(id)}/reject`,
      {
        method: "POST",
        idempotent: true,
        ...(reason ? { body: JSON.stringify({ reason }) } : {}),
      }
    );
  }

  /**
   * POST /v1/responses/pending/{id}/withdraw — the submitter withdraws their own
   * held response (scope responses:write).
   */
  withdrawPendingResponse(id: string): Promise<PendingActionResult> {
    return this.request<PendingActionResult>(
      `/v1/responses/pending/${encodeURIComponent(id)}/withdraw`,
      { method: "POST", idempotent: true }
    );
  }

  /**
   * GET /v1/responses/approval-policy — which response types require approval
   * before they are sealed + sent (scope responses:read).
   */
  getApprovalPolicy(): Promise<ApprovalPolicy> {
    return this.request<ApprovalPolicy>(`/v1/responses/approval-policy`, {
      method: "GET",
    });
  }

  /**
   * PUT /v1/responses/approval-policy — set the response types that require
   * approval (scope responses:write). The sentinel "ALL" means every type.
   *
   * NOTE (unverified against server): body shape assumed to be
   * {"responseTypes": [...]} — confirm against the PR #253 controller.
   */
  setApprovalPolicy(responseTypes: string[]): Promise<ApprovalPolicy> {
    return this.request<ApprovalPolicy>(`/v1/responses/approval-policy`, {
      method: "PUT",
      body: JSON.stringify({ responseTypes }),
    });
  }

  // ── Multi-org chat ─────────────────────────────────────────────────────────

  /**
   * POST /v1/chats — open a chat anchored to a node/edge. Caller and every
   * named participant must be PARTIES to the target (server enforces: non-party
   * caller → 403, non-party participant → 400). Returns the ChatView.
   */
  createChat(input: {
    target: ChatTarget;
    participants: string[];
    title?: string;
  }): Promise<ChatView> {
    const body: Record<string, unknown> = {
      target: input.target,
      participants: input.participants,
    };
    if (input.title) body.title = input.title;
    return this.request<ChatView>(`/v1/chats`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** POST /v1/chats/{id}/messages — post a message; the server seals a copy per participant. */
  postChatMessage(chatId: string, body: string): Promise<ChatMessageResult> {
    return this.request<ChatMessageResult>(
      `/v1/chats/${encodeURIComponent(chatId)}/messages`,
      { method: "POST", body: JSON.stringify({ body }) }
    );
  }

  /** POST /v1/chats/{id}/participants — add a party org to an existing chat. */
  addChatParticipant(chatId: string, org: string): Promise<ChatView> {
    return this.request<ChatView>(
      `/v1/chats/${encodeURIComponent(chatId)}/participants`,
      { method: "POST", body: JSON.stringify({ org }) }
    );
  }

  /** GET /v1/chats/{id} — chat metadata + the caller's decrypted message copies. */
  getChat(chatId: string): Promise<ChatDetail> {
    return this.request<ChatDetail>(`/v1/chats/${encodeURIComponent(chatId)}`, {
      method: "GET",
    });
  }

  /** GET /v1/chats?target=<kind>:<id> — chats anchored to a node/edge. */
  listChats(target: ChatTarget): Promise<ChatView[]> {
    const q = `?target=${encodeURIComponent(`${target.kind}:${target.id}`)}`;
    return this.request<ChatView[]>(`/v1/chats${q}`, { method: "GET" });
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  /**
   * POST /v1/attachments — upload an attachment as base64 JSON. The server seals
   * it (no client crypto). Caller + participants must be parties to the target.
   */
  createAttachment(input: AttachmentCreate): Promise<AttachmentView> {
    const body: Record<string, unknown> = {
      target: input.target,
      contentBase64: input.contentBase64,
    };
    if (input.filename) body.filename = input.filename;
    if (input.mimeType) body.mimeType = input.mimeType;
    if (input.participants && input.participants.length > 0) {
      body.participants = input.participants;
    }
    return this.request<AttachmentView>(`/v1/attachments`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** GET /v1/attachments/{id} — attachment metadata (no bytes). */
  getAttachment(attachmentId: string): Promise<AttachmentView> {
    return this.request<AttachmentView>(
      `/v1/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "GET" }
    );
  }

  /**
   * GET /v1/attachments/{id}/download — raw bytes (server-decrypted). Returns a
   * Buffer plus the Content-Type and Content-Disposition filename.
   */
  async downloadAttachment(attachmentId: string): Promise<AttachmentDownload> {
    return this.requestBytes(
      `/v1/attachments/${encodeURIComponent(attachmentId)}/download`,
      { method: "GET" }
    );
  }

  /** GET /v1/attachments?target=<kind>:<id> — attachments anchored to a node/edge. */
  listAttachments(target: ChatTarget): Promise<AttachmentView[]> {
    const q = `?target=${encodeURIComponent(`${target.kind}:${target.id}`)}`;
    return this.request<AttachmentView[]>(`/v1/attachments${q}`, { method: "GET" });
  }

  // ── FIR — Fraud Incident Response ──────────────────────────────────────────
  //
  // A FIR is a multi-message FI-to-FI fraud case (NOTICE → RESPONSE →
  // REFUND_INSTRUCTION → REFUND_CONFIRMATION), one workflow instance whose id is
  // the fir_id. There is NO list-cases endpoint — a receiver discovers incoming
  // cases through the same /v1/affordances discovery the responder loop uses
  // (FIR cases are FIR_FRAUD_CASE_V1 workflow instances addressed to them).
  //
  // Request bodies are camelCase (Jackson default; the sealed envelope Vanta
  // assembles server-side is snake_case, but that is not the body we send).
  // Scopes: create/instruct need workflows:write; response/confirm delegate to
  // the response path (responses:write); read needs workflows:read.

  /** POST /v1/fir/cases — open a case with a NOTICE (sending bank → receiver). */
  createFirNotice(body: FirCreateNoticeRequest): Promise<FirOpenCaseResult> {
    return this.request<FirOpenCaseResult>(`/v1/fir/cases`, {
      method: "POST",
      idempotent: true,
      body: JSON.stringify(body),
    });
  }

  /** POST /v1/fir/cases/{firId}/response — per-transaction RESPONSE (receiver → bank). */
  submitFirResponse(firId: string, body: FirSubmitResponseRequest): Promise<ResponseResult> {
    return this.request<ResponseResult>(
      `/v1/fir/cases/${encodeURIComponent(firId)}/response`,
      { method: "POST", idempotent: true, body: JSON.stringify(body) }
    );
  }

  /**
   * POST /v1/fir/cases/{firId}/refund-instruction — instruct a refund
   * (sending bank → receiver). Returns the assembled REFUND_INSTRUCTION wire
   * envelope (an arbitrary JSON object).
   */
  instructFirRefund(
    firId: string,
    body: FirRefundInstructionRequest
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/v1/fir/cases/${encodeURIComponent(firId)}/refund-instruction`,
      { method: "POST", idempotent: true, body: JSON.stringify(body) }
    );
  }

  /**
   * POST /v1/fir/cases/{firId}/refund-confirmation — confirm a refund executed
   * (receiver → bank). The RefundExecution is supplied as a pre-sealed
   * payloadId so the receiver's per-type human-approval hold (#253) can gate it
   * (202 PENDING_APPROVAL) without holding cleartext.
   */
  confirmFirRefund(firId: string, body: FirConfirmRefundRequest): Promise<ResponseResult> {
    return this.request<ResponseResult>(
      `/v1/fir/cases/${encodeURIComponent(firId)}/refund-confirmation`,
      { method: "POST", idempotent: true, body: JSON.stringify(body) }
    );
  }

  /** GET /v1/fir/cases/{firId} — content-blind case metadata (party-only). */
  getFirCase(firId: string): Promise<FirCaseView> {
    return this.request<FirCaseView>(`/v1/fir/cases/${encodeURIComponent(firId)}`, {
      method: "GET",
    });
  }
}

/** Extract a filename from a Content-Disposition header, if present. */
function filenameFromDisposition(disposition?: string): string | undefined {
  if (!disposition) return undefined;
  // RFC 5987 filename*=UTF-8''… takes precedence over a plain filename=.
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to plain */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain?.[1]?.trim();
}
