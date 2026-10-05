/**
 * ARM release-id forward — thin CLI/MCP.
 *
 * After POST /v1/requests/{id}/response (or a human RELEASED approve) returns
 * a released decision with releaseId, the v3 formal respond carries
 * X-Reqport-Arm-Release-Id. HOLD and DECLINE do not. ARM_RELEASE_* errors
 * surface the server message and are never described as sealed and sent.
 *
 * Synthetic data only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReqportApiError, ReqportClient } from "../src/client.js";
import { performKycRespond, performRespond } from "../src/core.js";
import { runRespond } from "../src/commands/respond.js";
import { runPendingApprove } from "../src/commands/pending.js";
import { executeTool } from "../src/mcp/server.js";
import { releasedArmReleaseId, releaseIdFingerprint, serverDecision } from "../src/armSurface.js";
import { ARM_RELEASE_BODIES, ARM_RELEASE_CODES } from "../src/armReleaseContract.js";
import { explainError, reportCliError } from "../src/ui.js";
import { cleanupConfigDir, clearEnvKnobs, freshConfigDir } from "./helpers.js";

const API_KEY = "rqk_live_syntheticreleaseonly";
const BASE = "https://vanta.test";
const HEADER = "x-reqport-arm-release-id";

const RELEASE_REQUIRED = ARM_RELEASE_BODIES.ARM_RELEASE_REQUIRED;
const RELEASE_REPLAYED = ARM_RELEASE_BODIES.ARM_RELEASE_REPLAYED;
const RELEASE_SHAPE = ARM_RELEASE_BODIES.ARM_RELEASE_SHAPE_MISMATCH;

/** Real gate shape. An extra field proves the client does not rebuild slug/itemModes/presence. */
const SHAPE = {
  slug: "information",
  itemModes: ["unstructured"],
  presence: { freeText: false, accounts: false },
  gateStamp: "synthetic-shape-1",
};

function autoRelease(releaseId: string, extra: Record<string, unknown> = {}) {
  return { disposition: "AUTO_RELEASE", releaseId, shape: SHAPE, messageId: "msg-auto", ...extra };
}

type Call = {
  url: string;
  method: string;
  body?: unknown;
  releaseId?: string;
  idempotencyKey?: string;
};

function workflow(id: string, workflowType: string) {
  return { workflowInstanceId: id, workflowType, status: "SENT" };
}

function mockVanta(
  handler: (call: { url: string; method: string; body?: unknown; releaseId?: string }) => {
    status: number;
    json: unknown;
  }
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const raw = typeof init?.body === "string" ? init.body : undefined;
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      const releaseId = headers.get(HEADER) ?? undefined;
      const idempotencyKey = headers.get("idempotency-key") ?? undefined;
      calls.push({ url, method, body, releaseId, idempotencyKey });
      const res = handler({ url, method, body, releaseId });
      return new Response(JSON.stringify(res.json), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }
  );
  return calls;
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const se = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    restore() {
      so.mockRestore();
      se.mockRestore();
    },
  };
}

function assertNoReleaseClaim(text: string) {
  expect(text).not.toMatch(/sealed and sent/i);
}

function assertNoKey(text: string) {
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain("rqk_live_");
}

let dir: string;

beforeEach(() => {
  dir = freshConfigDir();
  clearEnvKnobs();
  process.env.REQPORT_API_KEY = API_KEY;
  process.env.REQPORT_BASE_URL = BASE;
  process.env.REQPORT_ENV = "sandbox";
});

afterEach(() => {
  cleanupConfigDir(dir);
  clearEnvKnobs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("release id is forwarded only when the server released", () => {
  it("keeps Gap 6 exact matching, including human RELEASED", () => {
    expect(serverDecision({ disposition: "AUTO_RELEASE" })).toBe("released");
    expect(serverDecision({ disposition: "RELEASED" })).toBe("released");
    expect(serverDecision({ disposition: "HOLD" })).toBe("held");
    expect(serverDecision({ disposition: "DECLINE" })).toBe("declined");
    // disposition wins over a conflicting legacy token
    expect(serverDecision({ disposition: "HOLD", action: "AUTO_RELEASE" })).toBe("held");
    expect(serverDecision({ disposition: "auto_release", action: "AUTO_RELEASE" })).toBe("unspecified");
    // legacy fields remain the fallback when disposition is absent
    expect(serverDecision({ action: "AUTO_RELEASE" })).toBe("released");
    expect(serverDecision({ status: "RELEASED" })).toBe("released");
    expect(serverDecision({ action: "auto_release" })).toBe("unspecified");
    expect(serverDecision({ status: "UNRELEASED" })).toBe("unspecified");
    expect(serverDecision({ status: "NOT_SENT" })).toBe("unspecified");
    expect(serverDecision({ approvalState: "HOLD_FOR_APPROVAL" })).toBe("held");
    expect(serverDecision({ status: "RESPONSE_DECLINED" })).toBe("declined");
    expect(releasedArmReleaseId({ disposition: "AUTO_RELEASE", releaseId: "rel-1" })).toBe("rel-1");
    expect(releasedArmReleaseId({ disposition: "HOLD", releaseId: "rel-hold", shape: SHAPE })).toBeUndefined();
    expect(releasedArmReleaseId({ action: "AUTO_RELEASE", releaseId: "rel-legacy" })).toBe("rel-legacy");
    expect(releasedArmReleaseId({ action: "auto_release", releaseId: "rel-lower" })).toBeUndefined();
    expect(releasedArmReleaseId({ disposition: "RELEASED", releaseId: "  " })).toBeUndefined();
  });

  it("AUTO_RELEASE on POST /v1/requests/{id}/response sends X-Reqport-Arm-Release-Id on v3", async () => {
    const id = "req-auto";
    const releaseId = "rel-auto-synthetic";
    const calls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return {
          status: 200,
          json: autoRelease(releaseId),
        };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${id}/respond`)) {
        return { status: 200, json: { workflowInstanceId: id, status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });

    const io = captureIo();
    const code = await runRespond("sandbox", id, {
      status: "NFOU",
      yes: true,
      show: false,
    });
    io.restore();

    expect(code).toBe(0);
    const gate = calls.find((c) => c.url.endsWith(`/v1/requests/${id}/response`));
    const formal = calls.find((c) => c.url.endsWith(`/v3/workflows/${id}/respond`));
    expect(gate?.releaseId).toBeUndefined();
    expect(formal?.method).toBe("POST");
    expect(formal?.releaseId).toBe(releaseId);
    expect(formal?.body).toMatchObject({ nfou: true, correlationId: "msg-auto" });
    expect((formal?.body as { shape?: unknown }).shape).toEqual(SHAPE);
    expect(formal?.idempotencyKey).toBeUndefined();
    expect(io.stdout()).toContain("The server released this answer.");
    expect(io.stdout()).toContain(releaseId);
    assertNoReleaseClaim(io.stdout());
    assertNoKey(io.stdout());
  });

  it("MCP generic respond forwards the same header on AUTO_RELEASE and omits it on HOLD", async () => {
    const id = "req-mcp-auto";
    const releaseId = "rel-mcp-synthetic";
    const autoCalls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return { status: 200, json: autoRelease(releaseId) };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${id}/respond`)) {
        return { status: 200, json: { status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    const auto = await executeTool(undefined, (client) =>
      performRespond(client, id, { status: "NFOU" })
    );
    expect(auto).not.toHaveProperty("isError");
    expect(autoCalls.find((c) => c.url.includes("/v3/workflows/"))?.releaseId).toBe(releaseId);
    expect(autoCalls.find((c) => c.url.endsWith("/response"))?.releaseId).toBeUndefined();
    expect((autoCalls.find((c) => c.url.includes("/v3/workflows/"))?.body as { shape?: unknown }).shape).toEqual(
      SHAPE
    );
    assertNoReleaseClaim(auto.content[0].text);
    assertNoKey(auto.content[0].text);

    vi.unstubAllGlobals();
    const holdId = "req-mcp-hold";
    const holdCalls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${holdId}`)) {
        return { status: 200, json: workflow(holdId, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${holdId}/response`)) {
        return { status: 202, json: { disposition: "HOLD" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const hold = await executeTool(undefined, (client) =>
      performRespond(client, holdId, { status: "NFOU" })
    );
    expect(hold).not.toHaveProperty("isError");
    expect(holdCalls.some((c) => c.url.includes("/v3/"))).toBe(false);
    expect(holdCalls.every((c) => c.releaseId === undefined)).toBe(true);
    const outcome = JSON.parse(hold.content[0].text) as { result: { disposition: string; releaseId?: string; shape?: unknown } };
    expect(outcome.result).toEqual({ disposition: "HOLD" });
    expect(outcome.result.releaseId).toBeUndefined();
    expect(outcome.result.shape).toBeUndefined();
    assertNoReleaseClaim(hold.content[0].text);
  });

  it("HOLD and DECLINE on qp respond send no release header and do not claim sealed and sent", async () => {
    const holdId = "req-hold";
    const holdCalls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${holdId}`)) {
        return { status: 200, json: workflow(holdId, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${holdId}/response`)) {
        return { status: 202, json: { disposition: "HOLD" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    const holdIo = captureIo();
    expect(
      await runRespond("sandbox", holdId, { status: "NFOU", yes: true, show: false })
    ).toBe(0);
    holdIo.restore();
    expect(holdCalls.some((c) => c.url.includes("/v3/"))).toBe(false);
    expect(holdCalls.every((c) => c.releaseId === undefined)).toBe(true);
    expect(holdIo.stdout()).toContain("Awaiting approval");
    assertNoReleaseClaim(holdIo.stdout());

    const declineId = "req-decline";
    const declineCalls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${declineId}`)) {
        return { status: 200, json: workflow(declineId, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${declineId}/response`)) {
        return { status: 200, json: { disposition: "DECLINE", reason: "ruleset" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    const declineIo = captureIo();
    expect(
      await runRespond("sandbox", declineId, { status: "NFOU", yes: true, show: false })
    ).toBe(0);
    declineIo.restore();
    expect(declineCalls.some((c) => c.url.includes("/v3/"))).toBe(false);
    expect(declineCalls.every((c) => c.releaseId === undefined)).toBe(true);
    expect(declineIo.stdout()).toContain("The server declined this answer.");
    assertNoReleaseClaim(declineIo.stdout());
  });

  it("a lowercase auto_release token does not forward a release id", async () => {
    const id = "req-case";
    const calls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return { status: 200, json: { disposition: "auto_release", releaseId: "rel-lower", shape: SHAPE } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    const io = captureIo();
    expect(await runRespond("sandbox", id, { status: "NFOU", yes: true, show: false })).toBe(0);
    io.restore();
    expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);
    expect(calls.every((c) => c.releaseId === undefined)).toBe(true);
    expect(io.stdout()).not.toContain("The server released");
    assertNoReleaseClaim(io.stdout());
  });

  it("binds a pre-sealed payload on the formal respond when the gate releases", async () => {
    const id = "req-payload";
    const payloadId = "11111111-1111-1111-1111-111111111111";
    const calls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return { status: 200, json: autoRelease("rel-payload") };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${id}/respond`)) {
        return { status: 200, json: { status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    await executeTool(undefined, (client) =>
      performRespond(client, id, { status: "COMP", payloadId, freeText: "see payload" })
    );
    const formal = calls.find((c) => c.url.includes("/v3/workflows/"));
    expect(formal?.releaseId).toBe("rel-payload");
    expect(formal?.body).toEqual({
      shape: SHAPE,
      correlationId: "msg-auto",
      responsePayload: { payloadId, purpose: "RESPONSE" },
    });
  });
});

describe("ARM_RELEASE_* refusals", () => {
  it("surfaces the contract message from the gate and does not call v3", async () => {
    const id = "req-gate-err";
    const calls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return { status: 409, json: RELEASE_SHAPE };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    let thrown: unknown;
    try {
      await runRespond("sandbox", id, { status: "NFOU", yes: true, show: false });
    } catch (e) {
      thrown = e;
    }
    const err = thrown as ReqportApiError;
    expect(err).toBeInstanceOf(ReqportApiError);
    expect(err.code).toBe("ARM_RELEASE_SHAPE_MISMATCH");
    const explained = explainError(err);
    expect(explained).toContain(RELEASE_SHAPE.message);
    expect(explained).toContain("ARM_RELEASE_SHAPE_MISMATCH");
    expect(explained).toContain("repeat-gate-shape");
    assertNoReleaseClaim(explained);
    expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);

    const io = captureIo();
    reportCliError(err, false);
    io.restore();
    expect(io.stderr()).toContain(RELEASE_SHAPE.message);
    assertNoReleaseClaim(io.stderr());
    assertNoKey(io.stderr());

    const mcp = await executeTool(undefined, (client) =>
      performRespond(client, id, { status: "NFOU" })
    );
    expect(mcp.isError).toBe(true);
    const envelope = JSON.parse(mcp.content[0].text);
    expect(envelope.body).toEqual(RELEASE_SHAPE);
    assertNoReleaseClaim(mcp.content[0].text);
  });

  it("surfaces an ARM_RELEASE_* from the formal respond and does not claim sealed and sent", async () => {
    const id = "req-formal-err";
    mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return { status: 200, json: autoRelease("rel-bad") };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${id}/respond`)) {
        return { status: 400, json: RELEASE_REQUIRED };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    const io = captureIo();
    let thrown: unknown;
    try {
      await runRespond("sandbox", id, { status: "NFOU", yes: true, show: false });
    } catch (e) {
      thrown = e;
    }
    io.restore();
    const err = thrown as ReqportApiError;
    expect(err).toBeInstanceOf(ReqportApiError);
    expect(err.code).toBe("ARM_RELEASE_REQUIRED");
    expect(explainError(err)).toContain(RELEASE_REQUIRED.message);
    assertNoReleaseClaim(explainError(err));
    assertNoReleaseClaim(io.stdout());
    expect(io.stdout()).not.toContain("The server released");

    const mcp = await executeTool(undefined, (client) =>
      performRespond(client, id, { status: "NFOU" })
    );
    expect(mcp.isError).toBe(true);
    expect(JSON.parse(mcp.content[0].text).body.message).toBe(RELEASE_REQUIRED.message);
    assertNoReleaseClaim(mcp.content[0].text);
  });
});

describe("human RELEASED approve", () => {
  it("forwards releaseId on the v3 formal respond and says sealed and sent only after that succeeds", async () => {
    const releaseId = "rel-human-synthetic";
    const requestId = "req-human";
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/responses/pending/pend-rel/approve")) {
        return {
          status: 200,
          json: {
            id: "pend-rel",
            disposition: "RELEASED",
            releaseId,
            requestId,
            shape: SHAPE,
            messageId: "msg-human",
          },
        };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${requestId}/respond`)) {
        return { status: 200, json: { workflowInstanceId: requestId, status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const io = captureIo();
    expect(await runPendingApprove("sandbox", "pend-rel", { yes: true })).toBe(0);
    io.restore();
    const formal = calls.find((c) => c.url.includes("/v3/workflows/"));
    expect(formal?.releaseId).toBe(releaseId);
    expect((formal?.body as { shape?: unknown }).shape).toEqual(SHAPE);
    expect(formal?.idempotencyKey).toBeUndefined();
    expect(calls.find((c) => c.url.includes("/approve"))?.releaseId).toBeUndefined();
    expect(io.stdout()).toMatch(/sealed and sent server-side/);
    expect(io.stdout()).toContain("RESPONDED");
    assertNoKey(io.stdout());
  });

  it("HOLD on approve sends no header and does not claim sealed and sent", async () => {
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/approve")) {
        return {
          status: 200,
          json: { id: "pend-hold", disposition: "HOLD" },
        };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const io = captureIo();
    expect(await runPendingApprove("sandbox", "pend-hold", { yes: true })).toBe(0);
    io.restore();
    expect(calls).toHaveLength(1);
    expect(calls[0].releaseId).toBeUndefined();
    expect(io.stdout()).toContain("awaiting approval");
    assertNoReleaseClaim(io.stdout());
  });

  it("a RELEASED approve with no requestId does not send a header or claim sealed and sent", async () => {
    const calls = mockVanta(() => ({
      status: 200,
      json: {
        id: "pend-noreq",
        disposition: "RELEASED",
        releaseId: "rel-noreq-synthetic-full-token-0123456789abcdef",
      },
    }));
    const io = captureIo();
    let thrown: unknown;
    try {
      await runPendingApprove("sandbox", "pend-noreq", { yes: true });
    } catch (e) {
      thrown = e;
    }
    io.restore();
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    const fullId = "rel-noreq-synthetic-full-token-0123456789abcdef";
    expect(message).toContain("formal respond was not sent");
    expect(message).toContain(releaseIdFingerprint(fullId));
    expect(message).not.toContain(fullId);
    expect(message).not.toMatch(/sealed and sent/i);
    expect(calls).toHaveLength(1);
    expect(calls[0].releaseId).toBeUndefined();
    assertNoReleaseClaim(io.stdout());
  });

  it("an ARM_RELEASE_* on the formal respond after RELEASED is not sealed and sent", async () => {
    mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/approve")) {
        return {
          status: 200,
          json: {
            id: "pend-bad",
            disposition: "RELEASED",
            releaseId: "rel-stale",
            requestId: "req-stale",
            shape: SHAPE,
          },
        };
      }
      if (method === "POST" && url.includes("/v3/workflows/")) {
        return { status: 409, json: RELEASE_REPLAYED };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    const io = captureIo();
    let thrown: unknown;
    try {
      await runPendingApprove("sandbox", "pend-bad", { yes: true });
    } catch (e) {
      thrown = e;
    }
    io.restore();
    const err = thrown as ReqportApiError;
    expect(err).toBeInstanceOf(ReqportApiError);
    const explained = explainError(err);
    expect(explained).toContain("Already submitted. Check the request status.");
    expect(explained).toContain(RELEASE_REPLAYED.message);
    expect(explained).toContain("already-submitted");
    assertNoReleaseClaim(explained);
    assertNoReleaseClaim(explainError(err));
    assertNoReleaseClaim(io.stdout());
  });
});

describe("contract codes, KYC, and no retry", () => {
  it("uses only the bots#10 ARM_RELEASE codes and never claims sealed and sent", () => {
    expect([...ARM_RELEASE_CODES]).toEqual([
      "ARM_RELEASE_REQUIRED",
      "ARM_RELEASE_NOT_FOUND",
      "ARM_RELEASE_REQUEST_MISMATCH",
      "ARM_RELEASE_REPLAYED",
      "ARM_RELEASE_SUPERSEDED",
      "ARM_RELEASE_EXPIRED",
      "ARM_RELEASE_SHAPE_MISMATCH",
    ]);
    expect(ARM_RELEASE_CODES as readonly string[]).not.toContain("ARM_RELEASE_NOT_RELEASED");
    for (const code of ARM_RELEASE_CODES) {
      const body = ARM_RELEASE_BODIES[code];
      const err = new ReqportApiError(409, "/v3/workflows/x/respond", JSON.stringify(body));
      const text = explainError(err);
      expect(text).toContain(body.message);
      expect(text).toContain(body.code);
      expect(text).toContain(body.steer.action);
      assertNoReleaseClaim(text);
    }
  });

  it("KYC respond does not forward an ARM release id and returns the KYC result", async () => {
    const id = "req-kyc";
    const kycBody = {
      disposition: "AUTO_RELEASE",
      releaseId: "rel-kyc-must-not-forward",
      shape: SHAPE,
      record_status: "NOT_FOUND",
    };
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/kyc-response`)) {
        return { status: 200, json: kycBody };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const client = new ReqportClient({
      env: "sandbox",
      baseUrl: BASE,
      credential: { value: API_KEY, kind: "apikey" },
    });
    const result = await performKycRespond(client, id, { recordStatus: "NOT_FOUND" });
    expect(result).toEqual(kycBody);
    expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);
    expect(calls.every((c) => c.releaseId === undefined)).toBe(true);
  });

  it("does not retry a formal respond when the response is lost", async () => {
    const id = "req-lost";
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const headers = new Headers(init?.headers);
      if (url.endsWith(`/v3/workflows/${id}/respond`)) {
        expect(headers.get("idempotency-key")).toBeNull();
        throw new Error("socket hang up");
      }
      if (url.endsWith(`/v1/workflows/${id}`)) {
        return new Response(JSON.stringify(workflow(id, "INFORMATION_FOLLOWUP")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith(`/v1/requests/${id}/response`)) {
        return new Response(JSON.stringify(autoRelease("rel-lost")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: "UNEXPECTED_TEST_ROUTE" }), { status: 500 });
    });
    let thrown: unknown;
    try {
      await runRespond("sandbox", id, { status: "NFOU", yes: true, show: false });
    } catch (e) {
      thrown = e;
    }
    expect(urls.filter((u) => u.includes("/v3/"))).toHaveLength(1);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("not retried");
    expect(message).toContain("ARM_RELEASE_REPLAYED");
    expect(message).toContain("check the request status");
    expect(message).not.toContain("rel-lost");
    assertNoReleaseClaim(message);
  });
});
