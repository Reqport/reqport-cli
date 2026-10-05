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
import { ReqportApiError } from "../src/client.js";
import { performRespond } from "../src/core.js";
import { runRespond } from "../src/commands/respond.js";
import { runPendingApprove } from "../src/commands/pending.js";
import { executeTool } from "../src/mcp/server.js";
import { releasedArmReleaseId, serverDecision } from "../src/armSurface.js";
import { explainError, reportCliError } from "../src/ui.js";
import { cleanupConfigDir, clearEnvKnobs, freshConfigDir } from "./helpers.js";

const API_KEY = "rqk_live_syntheticreleaseonly";
const BASE = "https://vanta.test";
const HEADER = "x-reqport-arm-release-id";

const RELEASE_REQUIRED = {
  code: "ARM_RELEASE_REQUIRED",
  family: "ARM",
  message: "Formal respond requires header X-Reqport-Arm-Release-Id.",
};

const RELEASE_NOT_RELEASED = {
  code: "ARM_RELEASE_NOT_RELEASED",
  family: "ARM",
  message: "This ARM release is not released.",
};

type Call = {
  url: string;
  method: string;
  body?: unknown;
  releaseId?: string;
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
      calls.push({ url, method, body, releaseId });
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
    expect(serverDecision({ action: "AUTO_RELEASE" })).toBe("released");
    expect(serverDecision({ status: "RELEASED" })).toBe("released");
    expect(serverDecision({ action: "auto_release" })).toBe("unspecified");
    expect(serverDecision({ status: "UNRELEASED" })).toBe("unspecified");
    expect(serverDecision({ status: "NOT_SENT" })).toBe("unspecified");
    expect(serverDecision({ approvalState: "HOLD_FOR_APPROVAL" })).toBe("held");
    expect(serverDecision({ status: "RESPONSE_DECLINED" })).toBe("declined");
    expect(releasedArmReleaseId({ action: "AUTO_RELEASE", releaseId: "rel-1" })).toBe("rel-1");
    expect(releasedArmReleaseId({ status: "HOLD_FOR_APPROVAL", releaseId: "rel-hold" })).toBeUndefined();
    expect(releasedArmReleaseId({ action: "auto_release", releaseId: "rel-lower" })).toBeUndefined();
    expect(releasedArmReleaseId({ status: "RELEASED", releaseId: "  " })).toBeUndefined();
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
          json: { action: "AUTO_RELEASE", status: "AUTO_RELEASE", releaseId, messageId: "msg-auto" },
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
        return { status: 200, json: { action: "AUTO_RELEASE", releaseId } };
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
    assertNoReleaseClaim(auto.content[0].text);
    assertNoKey(auto.content[0].text);

    vi.unstubAllGlobals();
    const holdId = "req-mcp-hold";
    const holdCalls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${holdId}`)) {
        return { status: 200, json: workflow(holdId, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${holdId}/response`)) {
        return {
          status: 202,
          json: {
            status: "PENDING_APPROVAL",
            approvalState: "HOLD_FOR_APPROVAL",
            releaseId: "rel-must-not-forward",
          },
        };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const hold = await executeTool(undefined, (client) =>
      performRespond(client, holdId, { status: "NFOU" })
    );
    expect(hold).not.toHaveProperty("isError");
    expect(holdCalls.some((c) => c.url.includes("/v3/"))).toBe(false);
    expect(holdCalls.every((c) => c.releaseId === undefined)).toBe(true);
    const outcome = JSON.parse(hold.content[0].text) as { result: { approvalState: string } };
    expect(outcome.result.approvalState).toBe("HOLD_FOR_APPROVAL");
    assertNoReleaseClaim(hold.content[0].text);
  });

  it("HOLD and DECLINE on qp respond send no release header and do not claim sealed and sent", async () => {
    const holdId = "req-hold";
    const holdCalls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${holdId}`)) {
        return { status: 200, json: workflow(holdId, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${holdId}/response`)) {
        return {
          status: 202,
          json: { status: "PENDING_APPROVAL", approvalState: "HOLD_FOR_APPROVAL", releaseId: "rel-nope" },
        };
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
        return {
          status: 200,
          json: { status: "RESPONSE_DECLINED", approvalState: "DECLINED", reason: "ruleset", releaseId: "rel-nope" },
        };
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
        return { status: 200, json: { action: "auto_release", releaseId: "rel-lower" } };
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
        return { status: 200, json: { status: "AUTO_RELEASE", releaseId: "rel-payload" } };
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
    expect(formal?.body).toMatchObject({
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
        return { status: 409, json: RELEASE_NOT_RELEASED };
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
    expect(err.code).toBe("ARM_RELEASE_NOT_RELEASED");
    const explained = explainError(err);
    expect(explained).toContain(RELEASE_NOT_RELEASED.message);
    expect(explained).toContain("ARM_RELEASE_NOT_RELEASED");
    assertNoReleaseClaim(explained);
    expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);

    const io = captureIo();
    reportCliError(err, false);
    io.restore();
    expect(io.stderr()).toContain(RELEASE_NOT_RELEASED.message);
    assertNoReleaseClaim(io.stderr());
    assertNoKey(io.stderr());

    const mcp = await executeTool(undefined, (client) =>
      performRespond(client, id, { status: "NFOU" })
    );
    expect(mcp.isError).toBe(true);
    const envelope = JSON.parse(mcp.content[0].text);
    expect(envelope.body).toEqual(RELEASE_NOT_RELEASED);
    assertNoReleaseClaim(mcp.content[0].text);
  });

  it("surfaces an ARM_RELEASE_* from the formal respond and does not claim sealed and sent", async () => {
    const id = "req-formal-err";
    mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "INFORMATION_FOLLOWUP") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/response`)) {
        return { status: 200, json: { action: "AUTO_RELEASE", releaseId: "rel-bad" } };
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
          json: { id: "pend-rel", status: "RELEASED", releaseId, requestId, messageId: "msg-human" },
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
          json: {
            id: "pend-hold",
            status: "PENDING_APPROVAL",
            approvalState: "HOLD_FOR_APPROVAL",
            releaseId: "rel-hold",
            requestId: "req-hold",
          },
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
      json: { id: "pend-noreq", status: "RELEASED", releaseId: "rel-noreq" },
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
    expect((thrown as Error).message).toContain("formal respond was not sent");
    expect((thrown as Error).message).not.toMatch(/sealed and sent/i);
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
            status: "RELEASED",
            releaseId: "rel-stale",
            requestId: "req-stale",
          },
        };
      }
      if (method === "POST" && url.includes("/v3/workflows/")) {
        return { status: 409, json: RELEASE_NOT_RELEASED };
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
    expect(explainError(err)).toContain(RELEASE_NOT_RELEASED.message);
    assertNoReleaseClaim(explainError(err));
    assertNoReleaseClaim(io.stdout());
  });
});
