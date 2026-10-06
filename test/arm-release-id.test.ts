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

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redactSecrets, redactValue, ReqportApiError, ReqportClient } from "../src/client.js";
import { performKycRespond, performRespond } from "../src/core.js";
import { runRespond } from "../src/commands/respond.js";
import { runPendingApprove } from "../src/commands/pending.js";
import { executeTool } from "../src/mcp/server.js";
import { ARM_RELEASE_ID_VISIBLE, displayReleaseId, RELEASE_ID_REDACTED, releasedArmReleaseId, serverDecision } from "../src/armSurface.js";
import { apiErrorEnvelope, explainError, reportCliError } from "../src/ui.js";
import {
  ARM_RELEASE_CODES,
  ARM_RELEASE_ID_GATE,
  ARM_RELEASE_ID_PATTERN,
  syntheticReleaseId,
} from "./fixtures/arm-release-id-gate.js";
import { cleanupConfigDir, clearEnvKnobs, freshConfigDir } from "./helpers.js";

const API_KEY = "rqk_live_syntheticreleaseonly";
const BASE = "https://vanta.test";
const HEADER = "x-reqport-arm-release-id";

const SHAPE = ARM_RELEASE_ID_GATE.autoRelease.shape;
const RELEASE_REQUIRED = ARM_RELEASE_ID_GATE.refusals.ARM_RELEASE_REQUIRED;
const RELEASE_REPLAYED = ARM_RELEASE_ID_GATE.refusals.ARM_RELEASE_REPLAYED;
const RELEASE_SHAPE = ARM_RELEASE_ID_GATE.refusals.ARM_RELEASE_SHAPE_MISMATCH;

function autoRelease(label: string, extra: Record<string, unknown> = {}) {
  return { ...ARM_RELEASE_ID_GATE.autoRelease, releaseId: syntheticReleaseId(label), ...extra };
}

function assertReleaseIdHidden(text: string, releaseId: string) {
  expect(text).not.toContain(releaseId);
  const secret = releaseId.startsWith("armrel_") ? releaseId.slice("armrel_".length) : releaseId;
  expect(secret.length).toBeGreaterThan(0);
  expect(text).not.toContain(secret);
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
    const shown = syntheticReleaseId("display");
    expect(ARM_RELEASE_ID_PATTERN.test(shown)).toBe(true);
    expect(ARM_RELEASE_ID_PATTERN.test(ARM_RELEASE_ID_GATE.autoRelease.releaseId)).toBe(false);
    expect(displayReleaseId(shown)).toBe(ARM_RELEASE_ID_VISIBLE);
    expect(displayReleaseId(shown)).toBe("armrel_…");
    expect(displayReleaseId(shown)).not.toContain(shown.slice("armrel_".length));
    expect(displayReleaseId("rel-noreq-synthetic-full-token-0123456789abcdef")).toBe(RELEASE_ID_REDACTED);
    expect(Object.keys(SHAPE.presence)).toEqual(["accounts", "statement"]);
    expect(ARM_RELEASE_ID_GATE.hold.disposition).toBe("HOLD_FOR_APPROVAL");
    expect(ARM_RELEASE_ID_GATE.hold).not.toHaveProperty("releaseId");
    expect(ARM_RELEASE_ID_GATE.decline).not.toHaveProperty("releaseId");
    expect(ARM_RELEASE_ID_GATE.autoRelease).toMatchObject({
      expiresAt: "2026-10-05T21:43:00Z",
      ttlSeconds: 120,
      requestId: "req_EXAMPLE",
    });
  });

  it("AUTO_RELEASE on POST /v1/requests/{id}/response sends X-Reqport-Arm-Release-Id on v3", async () => {
    const id = "req-auto";
    const releaseId = syntheticReleaseId("auto");
    const calls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return {
          status: 200,
          json: { ...ARM_RELEASE_ID_GATE.autoRelease, releaseId },
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
    expect(ARM_RELEASE_ID_PATTERN.test(formal?.releaseId ?? "")).toBe(true);
    expect(formal?.releaseId).not.toBe(ARM_RELEASE_ID_GATE.autoRelease.releaseId);
    expect(formal?.body).toEqual({ shape: SHAPE, nfou: true });
    expect(formal?.idempotencyKey).toBeUndefined();
    expect(io.stdout()).toContain("The server released this answer.");
    expect(io.stdout()).toMatch(/release id:\s+armrel_…/);
    assertReleaseIdHidden(io.stdout(), releaseId);
    assertNoReleaseClaim(io.stdout());
    assertNoKey(io.stdout());
  });

  it("MCP generic respond forwards the same header on AUTO_RELEASE and omits it on HOLD", async () => {
    const id = "req-mcp-auto";
    const releaseId = syntheticReleaseId("mcp");
    const autoCalls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return { status: 200, json: { ...ARM_RELEASE_ID_GATE.autoRelease, releaseId } };
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
    assertReleaseIdHidden(auto.content[0].text, releaseId);
    expect(JSON.parse(auto.content[0].text).result.releaseId).toBe("armrel_…");
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
        return { status: 202, json: ARM_RELEASE_ID_GATE.hold };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const hold = await executeTool(undefined, (client) =>
      performRespond(client, holdId, { status: "NFOU" })
    );
    expect(hold).not.toHaveProperty("isError");
    expect(holdCalls.some((c) => c.url.includes("/v3/"))).toBe(false);
    expect(holdCalls.every((c) => c.releaseId === undefined)).toBe(true);
    const outcome = JSON.parse(hold.content[0].text) as { result: Record<string, unknown> };
    expect(outcome.result).toEqual(ARM_RELEASE_ID_GATE.hold);
    expect(outcome.result.disposition).toBe("HOLD_FOR_APPROVAL");
    expect(outcome.result).not.toHaveProperty("releaseId");
    expect(outcome.result).not.toHaveProperty("expiresAt");
    expect(outcome.result).not.toHaveProperty("ttlSeconds");
    assertNoReleaseClaim(hold.content[0].text);
  });

  it("HOLD and DECLINE on qp respond send no release header and do not claim sealed and sent", async () => {
    const holdId = "req-hold";
    const holdCalls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${holdId}`)) {
        return { status: 200, json: workflow(holdId, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${holdId}/response`)) {
        return { status: 202, json: ARM_RELEASE_ID_GATE.hold };
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
        return { status: 200, json: ARM_RELEASE_ID_GATE.decline };
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
    const gate = autoRelease("payload");
    const calls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return { status: 200, json: gate };
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
    expect(formal?.releaseId).toBe(gate.releaseId);
    expect(ARM_RELEASE_ID_PATTERN.test(gate.releaseId)).toBe(true);
    expect(formal?.body).toEqual({
      shape: SHAPE,
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
        return { status: RELEASE_SHAPE.http, json: RELEASE_SHAPE.body };
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
    expect(explained).toContain(RELEASE_SHAPE.body.message);
    expect(explained).toContain("ARM_RELEASE_SHAPE_MISMATCH");
    expect(explained).toContain("shape-must-match-release");
    expect(explained).toContain("not sealed or sent");
    expect(explained).not.toContain("Already submitted");
    assertNoReleaseClaim(explained);
    expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);

    const io = captureIo();
    reportCliError(err, false);
    io.restore();
    expect(io.stderr()).toContain(RELEASE_SHAPE.body.message);
    assertNoReleaseClaim(io.stderr());
    assertNoKey(io.stderr());

    const mcp = await executeTool(undefined, (client) =>
      performRespond(client, id, { status: "NFOU" })
    );
    expect(mcp.isError).toBe(true);
    const envelope = JSON.parse(mcp.content[0].text);
    expect(envelope.httpStatus).toBe(RELEASE_SHAPE.http);
    expect(envelope.body).toEqual(RELEASE_SHAPE.body);
    assertNoReleaseClaim(mcp.content[0].text);
  });

  it("surfaces an ARM_RELEASE_* from the formal respond and does not claim sealed and sent", async () => {
    const id = "req-formal-err";
    mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return { status: 200, json: autoRelease("formal-required") };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${id}/respond`)) {
        return { status: RELEASE_REQUIRED.http, json: RELEASE_REQUIRED.body };
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
    expect(err.status).toBe(403);
    expect(explainError(err)).toContain(RELEASE_REQUIRED.body.message);
    expect(explainError(err)).toContain("shared-gate-first");
    assertNoReleaseClaim(explainError(err));
    assertNoReleaseClaim(io.stdout());
    expect(io.stdout()).not.toContain("The server released");

    const mcp = await executeTool(undefined, (client) =>
      performRespond(client, id, { status: "NFOU" })
    );
    expect(mcp.isError).toBe(true);
    expect(JSON.parse(mcp.content[0].text).body).toEqual(RELEASE_REQUIRED.body);
    assertNoReleaseClaim(mcp.content[0].text);
  });
});

describe("human RELEASED approve", () => {
  it("forwards releaseId on the v3 formal respond and says sealed and sent only after that succeeds", async () => {
    const releaseId = syntheticReleaseId("human");
    const requestId = "req-human";
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/responses/pending/pend-rel/approve")) {
        return {
          status: 200,
          json: {
            ...ARM_RELEASE_ID_GATE.released,
            id: "pend-rel",
            releaseId,
            requestId,
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
    expect(ARM_RELEASE_ID_PATTERN.test(releaseId)).toBe(true);
    expect(releaseId).not.toBe(ARM_RELEASE_ID_GATE.released.releaseId);
    expect((formal?.body as { shape?: unknown }).shape).toEqual(SHAPE);
    expect(formal?.idempotencyKey).toBeUndefined();
    expect(calls.find((c) => c.url.includes("/approve"))?.releaseId).toBeUndefined();
    expect(io.stdout()).toMatch(/sealed and sent server-side/);
    expect(io.stdout()).toContain("RESPONDED");
    assertReleaseIdHidden(io.stdout(), releaseId);
    assertNoKey(io.stdout());
  });

  it("HOLD on approve sends no header and does not claim sealed and sent", async () => {
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/approve")) {
        return {
          status: 200,
          json: { ...ARM_RELEASE_ID_GATE.hold, id: "pend-hold" },
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
        releaseId: syntheticReleaseId("noreq"),
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
    const fullId = syntheticReleaseId("noreq");
    expect(message).toContain("formal respond was not sent");
    expect(message).toContain("armrel_…");
    expect(message).not.toContain(fullId.slice("armrel_".length));
    assertReleaseIdHidden(message, fullId);
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
            releaseId: syntheticReleaseId("stale"),
            requestId: "req-stale",
            shape: SHAPE,
          },
        };
      }
      if (method === "POST" && url.includes("/v3/workflows/")) {
        return { status: RELEASE_REPLAYED.http, json: RELEASE_REPLAYED.body };
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
    expect(explained).toContain(RELEASE_REPLAYED.body.message);
    expect(explained).toContain("already-used");
    expect(explained).toContain("not sealed or sent");
    expect(explained).toContain("Check the request status before trying again.");
    expect(explained).not.toContain("Already submitted");
    expect(apiErrorEnvelope(err).body).toEqual(RELEASE_REPLAYED.body);
    assertNoReleaseClaim(explained);
    assertNoReleaseClaim(explainError(err));
    assertNoReleaseClaim(io.stdout());
  });
});

describe("contract codes, KYC, and no retry", () => {
  it("uses only the bots#10 ARM_RELEASE codes and never claims sealed and sent", () => {
    expect(ARM_RELEASE_CODES).toEqual([
      "ARM_RELEASE_REQUIRED",
      "ARM_RELEASE_NOT_FOUND",
      "ARM_RELEASE_REQUEST_MISMATCH",
      "ARM_RELEASE_REPLAYED",
      "ARM_RELEASE_SUPERSEDED",
      "ARM_RELEASE_EXPIRED",
      "ARM_RELEASE_SHAPE_MISMATCH",
    ]);
    expect(ARM_RELEASE_CODES).not.toContain("ARM_RELEASE_NOT_RELEASED");
    const steerUse = {
      ARM_RELEASE_REQUIRED: "shared-gate-first",
      ARM_RELEASE_NOT_FOUND: "shared-gate-first",
      ARM_RELEASE_REQUEST_MISMATCH: "shared-gate-first",
      ARM_RELEASE_REPLAYED: "already-used",
      ARM_RELEASE_SUPERSEDED: "release-superseded",
      ARM_RELEASE_EXPIRED: "release-expired",
      ARM_RELEASE_SHAPE_MISMATCH: "shape-must-match-release",
    } as const;
    const httpStatus = {
      ARM_RELEASE_REQUIRED: 403,
      ARM_RELEASE_NOT_FOUND: 404,
      ARM_RELEASE_REQUEST_MISMATCH: 403,
      ARM_RELEASE_REPLAYED: 409,
      ARM_RELEASE_SUPERSEDED: 403,
      ARM_RELEASE_EXPIRED: 403,
      ARM_RELEASE_SHAPE_MISMATCH: 409,
    } as const;
    for (const code of ARM_RELEASE_CODES) {
      const key = code as keyof typeof ARM_RELEASE_ID_GATE.refusals;
      const refusal = ARM_RELEASE_ID_GATE.refusals[key];
      expect(refusal.http).toBe(httpStatus[key]);
      expect(refusal.body.steer.use).toBe(steerUse[key]);
      expect(refusal.body).not.toHaveProperty("steer.action");
      const err = new ReqportApiError(refusal.http, "/v3/workflows/x/respond", JSON.stringify(refusal.body));
      const text = explainError(err);
      expect(text).toContain(refusal.body.message);
      expect(text).toContain(refusal.body.code);
      expect(text).toContain(refusal.body.steer.use);
      expect(text).toContain("not sealed or sent");
      expect(text).not.toContain("Already submitted");
      assertNoReleaseClaim(text);
      expect(apiErrorEnvelope(err).httpStatus).toBe(refusal.http);
      expect(apiErrorEnvelope(err).body).toEqual(refusal.body);
    }
  });

  it("KYC respond does not forward an ARM release id and returns the KYC result", async () => {
    const id = "req-kyc";
    const kycBody = {
      disposition: "AUTO_RELEASE",
      releaseId: syntheticReleaseId("kyc"),
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
    const mcp = await executeTool(undefined, (client) =>
      performKycRespond(client, id, { recordStatus: "NOT_FOUND" })
    );
    assertReleaseIdHidden(mcp.content[0].text, kycBody.releaseId);
    expect(JSON.parse(mcp.content[0].text).releaseId).toBe(displayReleaseId(kycBody.releaseId));
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
        const leaked = headers.get(HEADER);
        throw new Error(`socket hang up url=https://vanta.test/v3/workflows/${id}/respond?releaseId=${leaked ?? ""}`);
      }
      if (url.endsWith(`/v1/workflows/${id}`)) {
        return new Response(JSON.stringify(workflow(id, "INFORMATION_FOLLOWUP")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith(`/v1/requests/${id}/response`)) {
        return new Response(JSON.stringify(autoRelease("lost")), {
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
    assertReleaseIdHidden(message, syntheticReleaseId("lost"));
    assertNoReleaseClaim(message);
  });

  it("hides the release id in --json, error text, and URLs while the header keeps it", async () => {
    const id = "req-json";
    const releaseId = syntheticReleaseId("json");
    const calls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return { status: 200, json: { ...ARM_RELEASE_ID_GATE.autoRelease, releaseId } };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${id}/respond`)) {
        return { status: 200, json: { status: "RESPONDED", releaseId } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    const io = captureIo();
    expect(await runRespond("sandbox", id, { status: "NFOU", yes: true, show: false, json: true })).toBe(0);
    io.restore();
    expect(calls.find((c) => c.url.includes("/v3/"))?.releaseId).toBe(releaseId);
    assertReleaseIdHidden(io.stdout(), releaseId);
    expect(JSON.parse(io.stdout()).result.releaseId).toBe("armrel_…");

    const leaked = {
      code: "ARM_RELEASE_NOT_FOUND",
      family: "ARM",
      message: `No ARM release exists for ${releaseId}.`,
      releaseId,
      url: `https://vanta.test/v3/workflows/${id}/respond?releaseId=${releaseId}`,
    };
    const err = new ReqportApiError(404, `/v3/workflows/${releaseId}/respond`, JSON.stringify(leaked));
    assertReleaseIdHidden(explainError(err), releaseId);
    assertReleaseIdHidden(err.message, releaseId);
    assertReleaseIdHidden(err.path, releaseId);
    const jsonIo = captureIo();
    reportCliError(err, true);
    jsonIo.restore();
    assertReleaseIdHidden(jsonIo.stdout(), releaseId);
    const envelope = JSON.parse(jsonIo.stdout()) as { body: { releaseId: string; url: string } };
    expect(envelope.body.releaseId).toBe("armrel_…");
    expect(envelope.body.url).toContain("armrel_…");

    const plain = "rel-noreq-synthetic-full-token-0123456789abcdef";
    const hidden = redactValue({ releaseId: plain, note: `see ${plain}` }) as { releaseId: string; note: string };
    expect(hidden.releaseId).toBe("[redacted]");
    expect(hidden.note).toBe("see [redacted]");
    expect(hidden.note).not.toContain(plain);
  });

  it("masks an API key with [redacted] and does not hash it", () => {
    const key = API_KEY;
    expect(redactSecrets(`token ${key} and Bearer ${key}`)).toBe("token [redacted] and Bearer [redacted]");
    const printed = redactValue({
      releaseId: key,
      note: `see ${key}`,
      authorization: `Bearer ${key}`,
    }) as { releaseId: string; note: string; authorization: string };
    const text = JSON.stringify(printed);
    expect(text).not.toContain(key);
    expect(text).not.toContain("rqk_live_");
    expect(printed.releaseId).toBe("[redacted]");
    expect(printed.note).toBe("see [redacted]");
    expect(printed.authorization).toBe("Bearer [redacted]");
    for (const file of ["../src/armSurface.ts", "../src/client.ts", "../src/ui.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toContain("createHash");
      expect(source).not.toContain("releaseIdFingerprint");
    }
  });
});
