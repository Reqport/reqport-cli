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
  ApiKeyInfo,
  AttestationResponse,
  BusinessRelationshipAnswer,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  DecryptBatchResponse,
  PayloadMetaResponse,
  ResponseResult,
  ResponseSubmission,
  WorkflowInstanceResponse,
} from "./types.js";

/** A resolved bearer credential. */
export type Credential = {
  value: string;
  kind: "apikey" | "jwt";
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
      /** Require a JWT (human) credential — key management cannot use an API key. */
      requireJwt?: boolean;
    } = {}
  ): Promise<T> {
    const { auth = true, idempotent = false, requireJwt = false, headers, ...rest } = init;
    const h: Record<string, string> = {
      Accept: "application/json",
      ...(headers as Record<string, string> | undefined),
    };
    if (rest.body !== undefined) h["Content-Type"] = "application/json";
    if (auth || requireJwt) {
      if (!this.credential) {
        throw new Error(
          "This operation requires authentication. Set REQPORT_API_KEY or run `qp login`."
        );
      }
      if (requireJwt && this.credential.kind !== "jwt") {
        throw new Error(
          "Key management requires a human login (ORG_ADMIN). Run `qp login` — an API key cannot mint or manage keys."
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

  // ── Key management (HUMAN JWT + ORG_ADMIN only) ────────────────────────────

  /**
   * POST /v1/orgs/me/api-keys — mint a new rqk_live_ key for the caller's org.
   * The cleartext key is returned ONCE. Requires a Signicat user JWT and
   * ORG_ADMIN (verified server-side via Consortium). An API key cannot call this.
   */
  createApiKey(req: CreateApiKeyRequest): Promise<CreateApiKeyResponse> {
    return this.request<CreateApiKeyResponse>(`/v1/orgs/me/api-keys`, {
      method: "POST",
      requireJwt: true,
      body: JSON.stringify({
        displayName: req.displayName,
        scopes: req.scopes ?? [],
        expiresInDays: req.expiresInDays ?? null,
      }),
    });
  }

  /** GET /v1/orgs/me/api-keys — list the org's keys (metadata only). */
  listApiKeys(): Promise<ApiKeyInfo[]> {
    return this.request<ApiKeyInfo[]>(`/v1/orgs/me/api-keys`, {
      method: "GET",
      requireJwt: true,
    });
  }

  /** DELETE /v1/orgs/me/api-keys/{keyId} — revoke a key. */
  revokeApiKey(keyId: string): Promise<void> {
    return this.request<void>(
      `/v1/orgs/me/api-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE", requireJwt: true }
    );
  }
}
