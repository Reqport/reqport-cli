/**
 * ARM two-step gaps against the live sandbox contract and ADR 0005.
 *
 * Free-text / UAR types are posted directly and never request a release id.
 * Structured answers still forward X-Reqport-Arm-Release-Id. The pending queue
 * reads submittedBy, status, and label, and can fetch one row. Synthetic data only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReqportApiError, ReqportClient } from "../src/client.js";
import {
  clearHeldArmReleases,
  hasHeldArmRelease,
  performPendingApprove,
  performPendingApproveOnly,
  performPendingSend,
  performRespond,
} from "../src/core.js";
import { runPendingApprove, runPendingList, runPendingShow } from "../src/commands/pending.js";
import { runRespond } from "../src/commands/respond.js";
import {
  executeTool,
  PENDING_APPROVE_TOOL_DESCRIPTION,
  PENDING_SEND_TOOL_DESCRIPTION,
} from "../src/mcp/server.js";
import { isDirectFreeTextWorkflow } from "../src/armSurface.js";
import { explainError } from "../src/ui.js";
import { ARM_RELEASE_ID_GATE, syntheticReleaseId } from "./fixtures/arm-release-id-gate.js";
import { cleanupConfigDir, clearEnvKnobs, freshConfigDir } from "./helpers.js";

const API_KEY = "rqk_live_syntheticreleaseonly";
const BASE = "https://vanta.test";
const HEADER = "x-reqport-arm-release-id";
const SHAPE = ARM_RELEASE_ID_GATE.autoRelease.shape;

const DIRECT_TYPES = [
  "UNSTRUCTURED_AUTHORITY_REQUEST_V1",
  "UNSTRUCTURED_REQUEST_V1",
  "AUTHORITY_REQUEST_V1",
  "information",
  "INFORMATION_FOLLOWUP",
  "edge.information.v1",
  "edge.general-information.v1",
] as const;

type Call = { url: string; method: string; body?: unknown; releaseId?: string };

function workflow(id: string, workflowType: string) {
  return { workflowInstanceId: id, workflowType, status: "SENT" };
}

function assertReleaseIdHidden(text: string, releaseId: string) {
  expect(text).not.toContain(releaseId);
  const secret = releaseId.startsWith("armrel_") ? releaseId.slice("armrel_".length) : releaseId;
  expect(text).not.toContain(secret);
}

function mockVanta(
  handler: (call: { url: string; method: string; body?: unknown; releaseId?: string }) => {
    status: number;
    json: unknown;
  }
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
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
  });
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

let dir: string;

beforeEach(() => {
  dir = freshConfigDir();
  clearEnvKnobs();
  process.env.REQPORT_API_KEY = API_KEY;
  process.env.REQPORT_BASE_URL = BASE;
  process.env.REQPORT_ENV = "sandbox";
});

afterEach(() => {
  clearHeldArmReleases();
  cleanupConfigDir(dir);
  clearEnvKnobs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function testClient(): ReqportClient {
  return new ReqportClient({
    env: "sandbox",
    baseUrl: BASE,
    credential: { value: API_KEY, kind: "apikey" },
  });
}

describe("direct free-text never requests a release id", () => {
  it("classifies the ADR 0005 types and leaves structured types on the two-step path", () => {
    for (const type of DIRECT_TYPES) expect(isDirectFreeTextWorkflow(type)).toBe(true);
    expect(isDirectFreeTextWorkflow("BUSINESS_RELATIONSHIP_CHECK_V1")).toBe(false);
    expect(isDirectFreeTextWorkflow("TRANSACTION_HISTORY_REQUEST_V1")).toBe(false);
    expect(isDirectFreeTextWorkflow("KYC_CDD_CHECK_V1")).toBe(false);
    expect(isDirectFreeTextWorkflow("STRUCTURED_OTHER_V1")).toBe(false);
    expect(isDirectFreeTextWorkflow(undefined)).toBe(false);
    expect(isDirectFreeTextWorkflow("  ")).toBe(false);
  });

  it.each(DIRECT_TYPES)(
    "%s posts the answer directly and does not call v3 even when the server returns a release id",
    async (workflowType) => {
      const id = `req-${workflowType}`;
      const releaseId = syntheticReleaseId(workflowType);
      const calls = mockVanta(({ url, method }) => {
        if (method === "GET" && url.endsWith(`/v1/workflows/${encodeURIComponent(id)}`)) {
          return { status: 200, json: workflow(id, workflowType) };
        }
        if (method === "POST" && url.endsWith(`/v1/requests/${encodeURIComponent(id)}/response`)) {
          return {
            status: 200,
            json: { ...ARM_RELEASE_ID_GATE.autoRelease, releaseId, requestId: id },
          };
        }
        return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
      });
      const io = captureIo();
      const code = await runRespond("sandbox", id, { status: "NFOU", yes: true, show: false, json: true });
      io.restore();
      expect(code).toBe(0);
      expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);
      expect(calls.some((c) => c.url.includes("arm-status"))).toBe(false);
      expect(calls.every((c) => c.releaseId === undefined)).toBe(true);
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
      const printed = JSON.parse(io.stdout()) as { formal?: unknown; result: { releaseId?: string } };
      expect(printed.formal).toBeUndefined();
      expect(printed.result.releaseId).toBe("armrel_…");
      assertReleaseIdHidden(io.stdout(), releaseId);
      expect(io.stdout()).not.toContain(API_KEY);
    }
  );
});

describe("structured answers still use the release id", () => {
  it("business-relationship AUTO_RELEASE sends the header on v3 and shows the gate window", async () => {
    const id = "req-br";
    const releaseId = syntheticReleaseId("br");
    const calls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "BUSINESS_RELATIONSHIP_CHECK_V1") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/business-relationship-response`)) {
        return { status: 200, json: { ...ARM_RELEASE_ID_GATE.autoRelease, releaseId, requestId: id } };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${id}/respond`)) {
        return { status: 200, json: { workflowInstanceId: id, status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const io = captureIo();
    expect(
      await runRespond("sandbox", id, { hasRelationship: "false", yes: true, show: false })
    ).toBe(0);
    io.restore();
    const formal = calls.find((c) => c.url.includes("/v3/workflows/"));
    expect(formal?.releaseId).toBe(releaseId);
    expect(formal?.body).toEqual({ shape: SHAPE, nfou: true });
    expect(calls.find((c) => c.url.includes("business-relationship-response"))?.releaseId).toBeUndefined();
    expect(io.stdout()).toContain("2026-10-05T21:43:00Z (ttl 120s)");
    assertReleaseIdHidden(io.stdout(), releaseId);
  });

  it("transaction-history AUTO_RELEASE sends the header on v3", async () => {
    const id = "req-tx";
    const releaseId = syntheticReleaseId("tx");
    const calls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
        return { status: 200, json: workflow(id, "TRANSACTION_HISTORY_REQUEST_V1") };
      }
      if (method === "POST" && url.endsWith(`/v1/requests/${id}/transaction-history-response`)) {
        return { status: 200, json: { ...ARM_RELEASE_ID_GATE.autoRelease, releaseId, requestId: id } };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${id}/respond`)) {
        return { status: 200, json: { status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const outcome = await executeTool(undefined, (client) =>
      performRespond(client, id, { statement: { profile: "camt.053-CA", entries: [] } })
    );
    expect(outcome).not.toHaveProperty("isError");
    const formal = calls.find((c) => c.url.includes("/v3/workflows/"));
    expect(formal?.releaseId).toBe(releaseId);
    expect((formal?.body as { shape?: unknown }).shape).toEqual(SHAPE);
    assertReleaseIdHidden(outcome.content[0].text, releaseId);
  });
});

describe("pending queue matches the held-response view", () => {
  it("lists submittedBy, status, and label, and redacts a release id", async () => {
    const releaseId = syntheticReleaseId("list");
    mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith("/v1/responses/pending")) {
        return {
          status: 200,
          json: [
            {
              id: "pend-open",
              requestId: "req-open",
              responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
              status: "PENDING",
              auth002Status: "COMP",
              submittedBy: "approver@example.com",
              createdAt: "2026-10-12T00:00:00Z",
            },
            {
              id: "pend-replaced",
              requestId: "req-replaced",
              responseType: "TRANSACTION_HISTORY_REQUEST_V1",
              status: "REPLACED",
              label: "Replaced by a newer submission.",
              closedBy: "newer-submission",
              submittedBy: "other@example.com",
              createdAt: "2026-10-11T00:00:00Z",
              releaseId,
            },
          ],
        };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const io = captureIo();
    expect(await runPendingList("sandbox", {})).toBe(0);
    io.restore();
    expect(io.stdout()).toContain("pend-open");
    expect(io.stdout()).toContain("PENDING");
    expect(io.stdout()).toContain("approver@example.com");
    expect(io.stdout()).toContain("REPLACED");
    expect(io.stdout()).toContain("Replaced by a newer submission.");
    expect(io.stdout()).toContain("qp pending show");
    assertReleaseIdHidden(io.stdout(), releaseId);
  });

  it("shows one row from GET /v1/responses/pending/{id} and does not print a release id", async () => {
    const releaseId = syntheticReleaseId("show");
    const calls = mockVanta(({ url, method }) => {
      if (method === "GET" && url.endsWith("/v1/responses/pending/pend-show")) {
        return {
          status: 200,
          json: {
            id: "pend-show",
            requestId: "req-show",
            responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
            status: "REPLACED",
            label: "Replaced by a newer submission.",
            closedBy: "newer-submission",
            decisionReason: "synthetic reason",
            submittedBy: "person@example.com",
            releaseId,
          },
        };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const io = captureIo();
    expect(await runPendingShow("sandbox", "pend-show", {})).toBe(0);
    io.restore();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(io.stdout()).toContain("REPLACED");
    expect(io.stdout()).toContain("newer-submission");
    expect(io.stdout()).toContain("person@example.com");
    expect(io.stdout()).toContain("synthetic reason");
    assertReleaseIdHidden(io.stdout(), releaseId);

    const jsonIo = captureIo();
    expect(await runPendingShow("sandbox", "pend-show", { json: true })).toBe(0);
    jsonIo.restore();
    const body = JSON.parse(jsonIo.stdout()) as { releaseId?: string; status?: string };
    expect(body.status).toBe("REPLACED");
    expect(body.releaseId).toBe("armrel_…");
    assertReleaseIdHidden(jsonIo.stdout(), releaseId);
  });

  it("qp pending approve forwards a structured release id and skips free-text", async () => {
    const releaseId = syntheticReleaseId("mcp-approve");
    const requestId = "req-mcp-approve";
    const structured = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/responses/pending/pend-mcp/approve")) {
        return {
          status: 200,
          json: {
            ...ARM_RELEASE_ID_GATE.released,
            id: "pend-mcp",
            releaseId,
            requestId,
            responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
          },
        };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${requestId}/respond`)) {
        return { status: 200, json: { status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const ok = await executeTool(undefined, (client) => performPendingApprove(client, "pend-mcp"));
    expect(ok).not.toHaveProperty("isError");
    expect(structured.find((c) => c.url.includes("/v3/"))?.releaseId).toBe(releaseId);
    assertReleaseIdHidden(ok.content[0].text, releaseId);
    expect(JSON.parse(ok.content[0].text).formal.status).toBe("RESPONDED");

    vi.unstubAllGlobals();
    const freeId = syntheticReleaseId("mcp-free");
    const freeCalls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.includes("/approve")) {
        return {
          status: 200,
          json: {
            id: "pend-free",
            disposition: "RELEASED",
            releaseId: freeId,
            requestId: "req-free",
            responseType: "UNSTRUCTURED_AUTHORITY_REQUEST_V1",
            shape: SHAPE,
          },
        };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const free = await executeTool(undefined, (client) => performPendingApprove(client, "pend-free"));
    expect(free).not.toHaveProperty("isError");
    expect(freeCalls.some((c) => c.url.includes("/v3/"))).toBe(false);
    expect(freeCalls.every((c) => c.releaseId === undefined)).toBe(true);
    expect(JSON.parse(free.content[0].text).formal).toBeUndefined();
    assertReleaseIdHidden(free.content[0].text, freeId);
  });

  it("approve of a replaced or already-decided row surfaces the 409 and does not call v3", async () => {
    const cases = [
      {
        code: "ARM_RELEASE_HELD_REPLACED",
        message: "synthetic replaced hold",
      },
      {
        code: "ARM_RELEASE_HELD_ALREADY_DECIDED",
        message: "synthetic already decided",
      },
    ] as const;
    for (const item of cases) {
      const calls = mockVanta(({ url, method }) => {
        if (method === "POST" && url.includes("/approve")) {
          return { status: 409, json: { code: item.code, message: item.message, family: "ARM" } };
        }
        return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
      });
      let thrown: unknown;
      try {
        await runPendingApprove("sandbox", "pend-409", { yes: true });
      } catch (e) {
        thrown = e;
      }
      const err = thrown as ReqportApiError;
      expect(err).toBeInstanceOf(ReqportApiError);
      expect(err.status).toBe(409);
      expect(err.code).toBe(item.code);
      const explained = explainError(err);
      expect(explained).toContain(item.message);
      expect(explained).toContain(item.code);
      expect(explained).not.toMatch(/sealed and sent/i);
      expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);
      vi.unstubAllGlobals();
    }
  });
});

describe("MCP approve and send are separate", () => {
  it("describes approve as approve-only and send as irreversible and single-use", () => {
    expect(PENDING_APPROVE_TOOL_DESCRIPTION).toContain("POST /v1/responses/pending/{id}/approve");
    expect(PENDING_APPROVE_TOOL_DESCRIPTION).toMatch(/never sends/);
    expect(PENDING_APPROVE_TOOL_DESCRIPTION).not.toMatch(/Seal \+ send/);
    expect(PENDING_SEND_TOOL_DESCRIPTION).toMatch(/irreversible/i);
    expect(PENDING_SEND_TOOL_DESCRIPTION).toMatch(/can be used only once/);
    expect(PENDING_SEND_TOOL_DESCRIPTION).toContain("X-Reqport-Arm-Release-Id");
  });

  it("reqport_pending_approve never posts v3 and returns the window and next step", async () => {
    const releaseId = syntheticReleaseId("approve-only");
    const requestId = "req-approve-only";
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/responses/pending/pend-only/approve")) {
        return {
          status: 200,
          json: {
            ...ARM_RELEASE_ID_GATE.released,
            id: "pend-only",
            releaseId,
            requestId,
            responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
          },
        };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const ok = await executeTool(undefined, (client) => performPendingApproveOnly(client, "pend-only"));
    expect(ok).not.toHaveProperty("isError");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/v1/responses/pending/pend-only/approve");
    expect(calls[0].releaseId).toBeUndefined();
    expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);
    const body = JSON.parse((ok as { content: { text: string }[] }).content[0].text) as {
      releaseId?: string;
      releaseWindow?: string;
      nextStep?: string;
      requestId?: string;
    };
    expect(body.releaseId).toBe("armrel_…");
    expect(body.releaseWindow).toBe("2026-10-05T21:45:00Z (ttl 120s)");
    expect(body.requestId).toBe(requestId);
    expect(body.nextStep).toContain("reqport_pending_send");
    expect(body.nextStep).toContain("confirm true");
    expect(body.nextStep).toContain(requestId);
    assertReleaseIdHidden((ok as { content: { text: string }[] }).content[0].text, releaseId);
  });

  it("refuses send without confirm and makes no network call", async () => {
    const calls = mockVanta(() => ({ status: 500, json: { code: "SHOULD_NOT_CALL" } }));
    const client = testClient();
    const releaseId = syntheticReleaseId("no-confirm");
    await expect(
      performPendingSend(client, {
        confirm: false,
        requestId: "req-no-confirm",
        responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
        releaseId,
      })
    ).rejects.toThrow(/confirm: true/);
    await expect(
      performPendingSend(client, {
        requestId: "req-no-confirm",
        responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
        releaseId,
      })
    ).rejects.toThrow(/confirm: true/);
    const viaTool = await executeTool(undefined, (c) =>
      performPendingSend(c, {
        confirm: false,
        requestId: "req-no-confirm",
        responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
        releaseId,
      })
    );
    expect(viaTool).toMatchObject({ isError: true });
    expect((viaTool as { content: { text: string }[] }).content[0].text).toMatch(/formal respond was not sent/i);
    expect(calls).toHaveLength(0);
  });

  it("send with confirm posts once with the release-id header", async () => {
    const releaseId = syntheticReleaseId("send-once");
    const requestId = "req-send-once";
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/responses/pending/pend-send/approve")) {
        return {
          status: 200,
          json: {
            ...ARM_RELEASE_ID_GATE.released,
            id: "pend-send",
            releaseId,
            requestId,
            responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
          },
        };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${requestId}/respond`)) {
        return { status: 200, json: { status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const client = testClient();
    const approved = await performPendingApproveOnly(client, "pend-send");
    expect(approved.nextStep).toContain(requestId);
    expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);

    const sent = await executeTool(undefined, (c) =>
      performPendingSend(c, {
        confirm: true,
        requestId,
        responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
      })
    );
    expect(sent).not.toHaveProperty("isError");
    const v3 = calls.filter((c) => c.url.includes("/v3/"));
    expect(v3).toHaveLength(1);
    expect(v3[0].method).toBe("POST");
    expect(v3[0].releaseId).toBe(releaseId);
    expect(v3[0].body).toMatchObject({ shape: SHAPE });
    const text = (sent as { content: { text: string }[] }).content[0].text;
    expect(JSON.parse(text).status).toBe("RESPONDED");
    assertReleaseIdHidden(text, releaseId);
    assertReleaseIdHidden(approved.nextStep, releaseId);
  });

  it("surfaces a replayed release as 409 and an expired release as 403", async () => {
    const cases = ["ARM_RELEASE_REPLAYED", "ARM_RELEASE_EXPIRED"] as const;
    for (const code of cases) {
      clearHeldArmReleases();
      const spec = ARM_RELEASE_ID_GATE.refusals[code];
      const releaseId = syntheticReleaseId(code);
      const requestId = `req-${code}`;
      const calls = mockVanta(({ url, method }) => {
        if (method === "POST" && url.includes("/approve")) {
          return {
            status: 200,
            json: {
              ...ARM_RELEASE_ID_GATE.released,
              id: `pend-${code}`,
              releaseId,
              requestId,
              responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
            },
          };
        }
        if (method === "POST" && url.includes("/v3/")) {
          return { status: spec.http, json: spec.body };
        }
        return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
      });
      const client = testClient();
      await performPendingApproveOnly(client, `pend-${code}`);
      let thrown: unknown;
      try {
        await performPendingSend(client, {
          confirm: true,
          requestId,
          responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
        });
      } catch (e) {
        thrown = e;
      }
      const err = thrown as ReqportApiError;
      expect(err).toBeInstanceOf(ReqportApiError);
      expect(err.status).toBe(spec.http);
      expect(err.code).toBe(code);
      const explained = explainError(err);
      expect(explained).toContain(spec.body.message);
      expect(explained).toContain("not sealed or sent");
      expect(explained).not.toMatch(/sealed and sent/i);
      if (code === "ARM_RELEASE_REPLAYED") {
        expect(explained).toContain("A release id is used once");
      }
      const v3 = calls.filter((c) => c.url.includes("/v3/"));
      expect(v3).toHaveLength(1);
      expect(v3[0].releaseId).toBe(releaseId);
      assertReleaseIdHidden(explained, releaseId);
      expect(hasHeldArmRelease(requestId)).toBe(false);
      const afterError = calls.length;
      await expect(
        performPendingSend(client, {
          confirm: true,
          requestId,
          responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
          releaseId,
        })
      ).rejects.toThrow(/No release id is held for request/);
      expect(calls).toHaveLength(afterError);

      vi.unstubAllGlobals();
      clearHeldArmReleases();
      const mcpCalls = mockVanta(({ url, method }) => {
        if (method === "POST" && url.includes("/approve")) {
          return {
            status: 200,
            json: {
              ...ARM_RELEASE_ID_GATE.released,
              releaseId,
              requestId,
              responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
            },
          };
        }
        if (method === "POST" && url.includes("/v3/")) {
          return { status: spec.http, json: spec.body };
        }
        return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
      });
      await performPendingApproveOnly(testClient(), `pend-${code}`);
      const mcp = await executeTool(undefined, (c) =>
        performPendingSend(c, {
          confirm: true,
          requestId,
          responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
        })
      );
      expect(mcp).toMatchObject({ isError: true });
      const text = (mcp as { content: { text: string }[] }).content[0].text;
      const envelope = JSON.parse(text) as { httpStatus: number; body: { code: string; message: string } };
      expect(envelope.httpStatus).toBe(spec.http);
      expect(envelope.body.code).toBe(code);
      expect(text).toContain("not sealed or sent");
      expect(text).not.toMatch(/sealed and sent/i);
      assertReleaseIdHidden(text, releaseId);
      expect(mcpCalls.filter((c) => c.url.includes("/v3/"))).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it("never puts free-text or UAR types on either tool's gate path", async () => {
    for (const responseType of DIRECT_TYPES) {
      clearHeldArmReleases();
      const releaseId = syntheticReleaseId(`free-${responseType}`);
      const calls = mockVanta(({ url, method }) => {
        if (method === "POST" && url.includes("/approve")) {
          return {
            status: 200,
            json: {
              disposition: "RELEASED",
              releaseId,
              requestId: "req-free-gate",
              responseType,
              shape: SHAPE,
              expiresAt: "2026-10-05T21:45:00Z",
              ttlSeconds: 120,
            },
          };
        }
        return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
      });
      const client = testClient();
      const approved = await performPendingApproveOnly(client, "pend-free-gate");
      expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);
      expect(approved.nextStep).toMatch(/not release-id gated/);
      expect(approved.nextStep).toMatch(/Do not call reqport_pending_send/);
      await expect(
        performPendingSend(client, {
          confirm: true,
          requestId: "req-free-gate",
          responseType,
          releaseId,
        })
      ).rejects.toThrow(/not release-id gated/);
      expect(calls).toHaveLength(1);
      expect(calls.every((c) => c.releaseId === undefined)).toBe(true);
      vi.unstubAllGlobals();
    }
  });

  it("keeps --json release-id redaction on qp pending approve", async () => {
    const releaseId = syntheticReleaseId("json-approve");
    const requestId = "req-json-approve";
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/responses/pending/pend-json/approve")) {
        return {
          status: 200,
          json: {
            ...ARM_RELEASE_ID_GATE.released,
            id: "pend-json",
            releaseId,
            requestId,
            responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
          },
        };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${requestId}/respond`)) {
        return { status: 200, json: { status: "RESPONDED", releaseId } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const io = captureIo();
    expect(await runPendingApprove("sandbox", "pend-json", { yes: true, json: true })).toBe(0);
    io.restore();
    assertReleaseIdHidden(io.stdout(), releaseId);
    const printed = JSON.parse(io.stdout()) as { releaseId?: string; formal?: { status?: string } };
    expect(printed.releaseId).toBe("armrel_…");
    expect(printed.formal?.status).toBe("RESPONDED");
    expect(calls.find((c) => c.url.includes("/v3/"))?.releaseId).toBe(releaseId);
  });

  it("refuses send when no release id is held for that request", async () => {
    const releaseId = syntheticReleaseId("no-hold");
    const calls = mockVanta(() => ({ status: 500, json: { code: "SHOULD_NOT_CALL" } }));
    const client = testClient();
    await expect(
      performPendingSend(client, {
        confirm: true,
        requestId: "req-no-hold",
        responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
        releaseId,
      })
    ).rejects.toThrow(/No release id is held for request req-no-hold/);
    expect(calls).toHaveLength(0);
    expect(hasHeldArmRelease("req-no-hold")).toBe(false);

    vi.unstubAllGlobals();
    const otherId = syntheticReleaseId("other-hold");
    const otherCalls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.includes("/approve")) {
        return {
          status: 200,
          json: {
            ...ARM_RELEASE_ID_GATE.released,
            releaseId: otherId,
            requestId: "req-other",
            responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
          },
        };
      }
      return { status: 500, json: { code: "SHOULD_NOT_CALL", url, method } };
    });
    await performPendingApproveOnly(testClient(), "pend-other");
    expect(hasHeldArmRelease("req-other")).toBe(true);
    await expect(
      performPendingSend(testClient(), {
        confirm: true,
        requestId: "req-no-hold",
        responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
        releaseId: otherId,
      })
    ).rejects.toThrow(/No release id is held for request req-no-hold/);
    expect(otherCalls.some((c) => c.url.includes("/v3/"))).toBe(false);
    expect(hasHeldArmRelease("req-other")).toBe(true);
    expect(hasHeldArmRelease("req-no-hold")).toBe(false);
  });

  it("refuses a caller release id that differs from the one held for the request", async () => {
    const heldId = syntheticReleaseId("held-match");
    const otherId = syntheticReleaseId("held-mismatch");
    const requestId = "req-mismatch";
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.includes("/approve")) {
        return {
          status: 200,
          json: {
            ...ARM_RELEASE_ID_GATE.released,
            releaseId: heldId,
            requestId,
            responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
          },
        };
      }
      return { status: 500, json: { code: "SHOULD_NOT_CALL", url, method } };
    });
    const client = testClient();
    await performPendingApproveOnly(client, "pend-mismatch");
    expect(hasHeldArmRelease(requestId)).toBe(true);
    let thrown: unknown;
    try {
      await performPendingSend(client, {
        confirm: true,
        requestId,
        responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
        releaseId: otherId,
      });
    } catch (e) {
      thrown = e;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toMatch(/does not match the one held for request req-mismatch/);
    expect(message).toMatch(/formal respond was not sent/i);
    assertReleaseIdHidden(message, heldId);
    assertReleaseIdHidden(message, otherId);
    expect(calls.some((c) => c.url.includes("/v3/"))).toBe(false);
    expect(calls).toHaveLength(1);
    expect(hasHeldArmRelease(requestId)).toBe(true);
  });

  it("deletes the held release id before the formal POST on MCP send and qp pending approve", async () => {
    const releaseId = syntheticReleaseId("drop-mcp");
    const requestId = "req-drop-mcp";
    let heldDuringPost: boolean | undefined;
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.includes("/approve")) {
        return {
          status: 200,
          json: {
            ...ARM_RELEASE_ID_GATE.released,
            releaseId,
            requestId,
            responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
          },
        };
      }
      if (method === "POST" && url.includes("/v3/")) {
        heldDuringPost = hasHeldArmRelease(requestId);
        return { status: 200, json: { status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const client = testClient();
    await performPendingApproveOnly(client, "pend-drop-mcp");
    expect(hasHeldArmRelease(requestId)).toBe(true);
    await performPendingSend(client, {
      confirm: true,
      requestId,
      responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
    });
    expect(heldDuringPost).toBe(false);
    expect(hasHeldArmRelease(requestId)).toBe(false);
    expect(calls.filter((c) => c.url.includes("/v3/"))).toHaveLength(1);
    expect(calls.find((c) => c.url.includes("/v3/"))?.releaseId).toBe(releaseId);
    const beforeRetry = calls.length;
    await expect(
      performPendingSend(client, {
        confirm: true,
        requestId,
        responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
        releaseId,
      })
    ).rejects.toThrow(/No release id is held for request/);
    expect(calls).toHaveLength(beforeRetry);

    vi.unstubAllGlobals();
    clearHeldArmReleases();
    const cliReleaseId = syntheticReleaseId("drop-cli");
    const cliRequestId = "req-drop-cli";
    let heldDuringCliPost: boolean | undefined;
    const cliCalls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/responses/pending/pend-drop-cli/approve")) {
        return {
          status: 200,
          json: {
            ...ARM_RELEASE_ID_GATE.released,
            releaseId: cliReleaseId,
            requestId: cliRequestId,
            responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
          },
        };
      }
      if (method === "POST" && url.includes("/v3/")) {
        heldDuringCliPost = hasHeldArmRelease(cliRequestId);
        return { status: 200, json: { status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const formal = await performPendingApprove(testClient(), "pend-drop-cli");
    expect(formal.formal?.status).toBe("RESPONDED");
    expect(heldDuringCliPost).toBe(false);
    expect(hasHeldArmRelease(cliRequestId)).toBe(false);
    const cliV3 = cliCalls.filter((c) => c.url.includes("/v3/"));
    expect(cliV3).toHaveLength(1);
    expect(cliV3[0].releaseId).toBe(cliReleaseId);
    const beforeCliRetry = cliCalls.length;
    await expect(
      performPendingSend(testClient(), {
        confirm: true,
        requestId: cliRequestId,
        responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
        releaseId: cliReleaseId,
      })
    ).rejects.toThrow(/No release id is held for request/);
    expect(cliCalls).toHaveLength(beforeCliRetry);
  });

  it("sends once with the release id held for that request", async () => {
    const releaseId = syntheticReleaseId("happy-held");
    const requestId = "req-happy-held";
    let heldDuringPost: boolean | undefined;
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/responses/pending/pend-happy/approve")) {
        return {
          status: 200,
          json: {
            ...ARM_RELEASE_ID_GATE.released,
            id: "pend-happy",
            releaseId,
            requestId,
            responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
          },
        };
      }
      if (method === "POST" && url.endsWith(`/v3/workflows/${requestId}/respond`)) {
        heldDuringPost = hasHeldArmRelease(requestId);
        return { status: 200, json: { status: "RESPONDED" } };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
    });
    const client = testClient();
    await performPendingApproveOnly(client, "pend-happy");
    expect(hasHeldArmRelease(requestId)).toBe(true);
    const sent = await performPendingSend(client, {
      confirm: true,
      requestId,
      responseType: "BUSINESS_RELATIONSHIP_CHECK_V1",
      releaseId,
    });
    expect(sent.status).toBe("RESPONDED");
    expect(heldDuringPost).toBe(false);
    const v3 = calls.filter((c) => c.url.includes("/v3/"));
    expect(v3).toHaveLength(1);
    expect(v3[0].releaseId).toBe(releaseId);
    expect(v3[0].body).toMatchObject({ shape: SHAPE });
    expect(hasHeldArmRelease(requestId)).toBe(false);
  });
});
