/**
 * ARM v0.1 Gap 6 — CLI and MCP are thin answer paths.
 *
 * The server (mocked here) decides HOLD, decline, ARM-off 403, and illegal
 * structured fields. These tests assert the client posts the same bodies and
 * returns the server JSON unchanged. Synthetic data only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReqportApiError, ReqportClient } from "../src/client.js";
import { performRespond } from "../src/core.js";
import { runRespond } from "../src/commands/respond.js";
import { runPendingApprove, runPendingReject } from "../src/commands/pending.js";
import { runArm } from "../src/commands/arm.js";
import { executeTool } from "../src/mcp/server.js";
import { serverDecision } from "../src/armSurface.js";
import { apiErrorEnvelope, explainError, reportCliError } from "../src/ui.js";
import { cleanupConfigDir, clearEnvKnobs, freshConfigDir } from "./helpers.js";

const API_KEY = "rqk_live_syntheticgap6only";
const BASE = "https://vanta.test";

const STEER = {
  action: "use-free-text-or-enable",
  discovery: "GET arm-status",
} as const;

const STRUCTURED_OFF = {
  code: "ARM_STRUCTURED_NOT_ENABLED",
  family: "ARM",
  message: "Structured ARM is not enabled for this authority.",
  steer: STEER,
};

const ILLEGAL_FIELDS = {
  code: "ARM_INFORMATION_STRUCTURED_FIELDS",
  family: "ARM",
  message: "An information answer cannot include structured fields.",
  rejectedFields: ["accounts", "statement"],
  steer: STEER,
};

/** Synthetic ruleset reject-steer. The code is whatever vanta sends; the client must not rename it. */
const RULESET_REJECT = {
  code: "ARM_RESPONSE_DECLINED",
  family: "ARM",
  message: "The requestor ruleset declined this response.",
  steer: STEER,
};

type Call = { url: string; method: string; body?: unknown; authorization?: string };

function workflow(id: string, workflowType: string) {
  return { workflowInstanceId: id, workflowType, status: "SENT" };
}

function mockVanta(
  handler: (call: { url: string; method: string; body?: unknown }) => {
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
      calls.push({
        url,
        method,
        body,
        authorization: headers.get("authorization") ?? undefined,
      });
      const res = handler({ url, method, body });
      return new Response(JSON.stringify(res.json), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }
  );
  return calls;
}

function route(
  id: string,
  workflowType: string,
  post: { includes: string; status: number; json: unknown }
): Call[] {
  return mockVanta(({ url, method }) => {
    if (method === "GET" && url.endsWith(`/v1/workflows/${id}`)) {
      return { status: 200, json: workflow(id, workflowType) };
    }
    if (method === "POST" && url.includes(post.includes)) {
      return { status: post.status, json: post.json };
    }
    return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url, method } };
  });
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

function assertNoKey(text: string) {
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain("rqk_live_");
}

function assertNoReleaseClaim(text: string) {
  expect(text).not.toMatch(/sealed and sent/i);
  expect(text).not.toMatch(/The server released/);
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

describe("AC 10 — CLI and MCP do not bypass a ruleset HOLD or reject", () => {
  it("qp respond surfaces HOLD and does not approve", async () => {
    const id = "req-hold";
    const calls = route(id, "BUSINESS_RELATIONSHIP_CHECK_V1", {
      includes: "/business-relationship-response",
      status: 202,
      json: {
        status: "PENDING_APPROVAL",
        approvalState: "HOLD_FOR_APPROVAL",
        messageId: "msg-hold",
      },
    });
    const io = captureIo();
    const code = await runRespond("sandbox", id, {
      hasRelationship: "false",
      yes: true,
      show: false,
    });
    io.restore();
    expect(code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/v1/workflows/${id}`,
      `POST ${BASE}/v1/requests/${id}/business-relationship-response`,
    ]);
    expect(calls.some((c) => c.url.includes("/approve"))).toBe(false);
    const text = io.stdout();
    expect(text).toContain("PENDING_APPROVAL");
    expect(text).toContain("HOLD_FOR_APPROVAL");
    expect(text).toContain("Awaiting approval");
    assertNoReleaseClaim(text);
    assertNoKey(text);
  });

  it("MCP reqport_respond_business_relationship returns the HOLD body and does not approve", async () => {
    const id = "req-hold-mcp";
    const calls = route(id, "BUSINESS_RELATIONSHIP_CHECK_V1", {
      includes: "/business-relationship-response",
      status: 202,
      json: { status: "PENDING_APPROVAL", approvalState: "HOLD_FOR_APPROVAL" },
    });
    const result = await executeTool(undefined, (client) =>
      performRespond(client, id, { hasRelationship: false })
    );
    expect(result).not.toHaveProperty("isError");
    const outcome = JSON.parse(result.content[0].text) as {
      endpoint: string;
      result: { status: string; approvalState: string };
    };
    expect(outcome.endpoint).toBe("business-relationship-response");
    expect(outcome.result).toEqual({
      status: "PENDING_APPROVAL",
      approvalState: "HOLD_FOR_APPROVAL",
    });
    expect(calls.some((c) => c.url.includes("/pending"))).toBe(false);
    assertNoKey(result.content[0].text);
  });

  it("a ruleset DECLINE on the response is not framed as a release", async () => {
    const id = "req-decline";
    const calls = route(id, "BUSINESS_RELATIONSHIP_CHECK_V1", {
      includes: "/business-relationship-response",
      status: 200,
      json: { status: "RESPONSE_DECLINED", approvalState: "DECLINED", reason: "ruleset" },
    });
    const io = captureIo();
    await runRespond("sandbox", id, { hasRelationship: "false", yes: true, show: false });
    io.restore();
    expect(io.stdout()).toContain("The server declined this answer.");
    expect(io.stdout()).toContain("ruleset");
    assertNoReleaseClaim(io.stdout());
    expect(calls.some((c) => c.url.includes("/approve"))).toBe(false);
  });

  it("a coded reject-steer is returned unchanged on CLI --json and MCP", async () => {
    const id = "req-steer";
    route(id, "KYC_CDD_CHECK_V1", {
      includes: "/kyc-response",
      status: 400,
      json: RULESET_REJECT,
    });
    const client = new ReqportClient({
      env: "sandbox",
      baseUrl: BASE,
      credential: { value: API_KEY, kind: "apikey" },
    });
    let thrown: unknown;
    try {
      await client.submitKycResponse(id, { record_status: "NOT_FOUND" });
    } catch (e) {
      thrown = e;
    }
    const err = thrown as ReqportApiError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("ARM_RESPONSE_DECLINED");
    expect(apiErrorEnvelope(err).body).toEqual(RULESET_REJECT);
    expect(explainError(err)).not.toMatch(/lacks the required scope/);
    expect(explainError(err)).not.toMatch(/HOLD/);

    const io = captureIo();
    reportCliError(err, true);
    io.restore();
    expect(JSON.parse(io.stdout())).toEqual({
      httpStatus: 400,
      path: `/v1/requests/${id}/kyc-response`,
      body: RULESET_REJECT,
    });
    assertNoKey(io.stdout());

    route(id, "BUSINESS_RELATIONSHIP_CHECK_V1", {
      includes: "/business-relationship-response",
      status: 400,
      json: RULESET_REJECT,
    });
    const mcp = await executeTool(undefined, (c) =>
      performRespond(c, id, { hasRelationship: false })
    );
    expect(mcp.isError).toBe(true);
    expect(JSON.parse(mcp.content[0].text)).toEqual({
      httpStatus: 400,
      path: `/v1/requests/${id}/business-relationship-response`,
      body: RULESET_REJECT,
    });
    expect(mcp.content[0].text).not.toMatch(/sealed and sent/i);
    assertNoKey(mcp.content[0].text);
  });

  it("pending approve leaves a server HOLD as HOLD and does not claim release", async () => {
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/responses/pending/pend-1/approve")) {
        return {
          status: 200,
          json: { id: "pend-1", status: "PENDING_APPROVAL", approvalState: "HOLD_FOR_APPROVAL" },
        };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    const io = captureIo();
    const code = await runPendingApprove("sandbox", "pend-1", { yes: true });
    io.restore();
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(io.stdout()).toContain("awaiting approval");
    expect(io.stdout()).toContain("HOLD_FOR_APPROVAL");
    assertNoReleaseClaim(io.stdout());
  });

  it("pending approve says sealed and sent only when the server status is released", async () => {
    mockVanta(() => ({
      status: 200,
      json: { id: "pend-rel", status: "RESPONDED", approvalState: "AUTO_RELEASE" },
    }));
    const io = captureIo();
    expect(await runPendingApprove("sandbox", "pend-rel", { yes: true })).toBe(0);
    io.restore();
    expect(io.stdout()).toMatch(/sealed and sent server-side/);
    expect(io.stdout()).toContain("RESPONDED");
  });

  it("pending approve with an unknown or empty status prints that status and does not claim release", async () => {
    mockVanta(() => ({ status: 200, json: { id: "pend-unk", status: "IN_REVIEW" } }));
    const unknown = captureIo();
    expect(await runPendingApprove("sandbox", "pend-unk", { yes: true })).toBe(0);
    unknown.restore();
    expect(unknown.stdout()).toContain("IN_REVIEW");
    assertNoReleaseClaim(unknown.stdout());

    mockVanta(() => ({ status: 200, json: { id: "pend-empty" } }));
    const empty = captureIo();
    expect(await runPendingApprove("sandbox", "pend-empty", { yes: true })).toBe(0);
    empty.restore();
    expect(empty.stdout()).toContain("(no status)");
    assertNoReleaseClaim(empty.stdout());
  });

  it("NOT_SENT and UNRELEASED stay unspecified for pending approve and qp respond", async () => {
    expect(serverDecision({ status: "NOT_SENT" })).toBe("unspecified");
    expect(serverDecision({ status: "UNRELEASED" })).toBe("unspecified");
    expect(serverDecision({ approvalState: "NOT_SENT" })).toBe("unspecified");
    expect(serverDecision({ status: "RESPONDED" })).toBe("released");
    expect(serverDecision({ action: "AUTO_RELEASE" })).toBe("released");
    expect(serverDecision({})).toBe("unspecified");
    expect(serverDecision({ status: "" })).toBe("unspecified");
    expect(serverDecision({ status: "IN_REVIEW" })).toBe("unspecified");

    for (const status of ["NOT_SENT", "UNRELEASED"]) {
      mockVanta(() => ({ status: 200, json: { id: "pend-x", status } }));
      const io = captureIo();
      expect(await runPendingApprove("sandbox", "pend-x", { yes: true })).toBe(0);
      io.restore();
      expect(io.stdout()).toContain(status);
      assertNoReleaseClaim(io.stdout());
    }

    for (const status of ["NOT_SENT", "UNRELEASED"]) {
      const id = `req-${status.toLowerCase()}`;
      route(id, "BUSINESS_RELATIONSHIP_CHECK_V1", {
        includes: "/business-relationship-response",
        status: 200,
        json: { status },
      });
      const respond = captureIo();
      expect(
        await runRespond("sandbox", id, { hasRelationship: "false", yes: true, show: false })
      ).toBe(0);
      respond.restore();
      expect(respond.stdout()).toContain(status);
      expect(respond.stdout()).not.toContain("The server released");
      assertNoReleaseClaim(respond.stdout());
    }
  });

  it("pending reject returns the server steer body", async () => {
    mockVanta(() => ({ status: 400, json: RULESET_REJECT }));
    const io = captureIo();
    await expect(runPendingReject("sandbox", "pend-9", { yes: true, reason: "no" })).rejects.toBeInstanceOf(
      ReqportApiError
    );
    io.restore();
    assertNoReleaseClaim(io.stdout());

    mockVanta(() => ({ status: 400, json: RULESET_REJECT }));
    const mcp = await executeTool(undefined, (c) => c.rejectPendingResponse("pend-9", "no"));
    expect(mcp.isError).toBe(true);
    expect(JSON.parse(mcp.content[0].text).body).toEqual(RULESET_REJECT);
    expect(JSON.parse(mcp.content[0].text).httpStatus).toBe(400);
  });
});

describe("AC 15 — ARM-off machine surface", () => {
  it("structured respond is HTTP 403 ARM_STRUCTURED_NOT_ENABLED, body unchanged", async () => {
    const id = "req-tx";
    const calls = route(id, "TRANSACTION_HISTORY_CHECK_V1", {
      includes: "/transaction-history-response",
      status: 403,
      json: STRUCTURED_OFF,
    });
    const mcp = await executeTool(undefined, (c) =>
      performRespond(c, id, { statement: { profile: "camt.053-CA", entries: [] } })
    );
    expect(mcp.isError).toBe(true);
    const envelope = JSON.parse(mcp.content[0].text);
    expect(envelope.httpStatus).toBe(403);
    expect(envelope.body).toEqual(STRUCTURED_OFF);
    expect(envelope.body.code).toBe("ARM_STRUCTURED_NOT_ENABLED");
    expect(mcp.content[0].text).not.toMatch(/lacks the required scope/);
    expect(mcp.content[0].text).not.toMatch(/HOLD_FOR_APPROVAL/);
    assertNoKey(mcp.content[0].text);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls[1].url).toContain("/transaction-history-response");
    assertNoKey(mcp.content[0].text);
  });

  it("qp respond on a transaction-history request surfaces the 403 steer", async () => {
    const id = "req-tx-cli";
    const statement = { profile: "camt.053-CA", statementId: "s-1", entries: [] as unknown[] };
    const file = join(mkdtempSync(join(tmpdir(), "qp-stmt-")), "statement.json");
    writeFileSync(file, JSON.stringify(statement));
    const calls = route(id, "TRANSACTION_HISTORY_CHECK_V1", {
      includes: "/transaction-history-response",
      status: 403,
      json: STRUCTURED_OFF,
    });
    let apiErr: unknown;
    try {
      await runRespond("sandbox", id, { statement: file, yes: true, show: false });
    } catch (e) {
      apiErr = e;
    }
    const err = apiErr as ReqportApiError;
    expect(err).toBeInstanceOf(ReqportApiError);
    expect(err.status).toBe(403);
    expect(apiErrorEnvelope(err).body).toEqual(STRUCTURED_OFF);
    expect(calls.filter((c) => c.method === "POST")[0].body).toMatchObject({ statement });
    const io = captureIo();
    reportCliError(err, true);
    io.restore();
    expect(JSON.parse(io.stdout())).toMatchObject({ httpStatus: 403, body: STRUCTURED_OFF });
    expect(io.stdout()).not.toMatch(/lacks the required scope/);
    assertNoKey(io.stdout());
  });

  it("structured create (kyc and transaction-history) returns the 403 body", async () => {
    const calls = mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/requests/kyc")) {
        return { status: 403, json: STRUCTURED_OFF };
      }
      if (method === "POST" && url.endsWith("/v1/requests/transaction-history")) {
        return { status: 403, json: STRUCTURED_OFF };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE", url } };
    });
    const kyc = await executeTool(undefined, (c) =>
      c.createDirectKyc({
        responderDomain: "holder.example",
        subjectOrgNr: "5590000000",
        invstgtnId: "INV-SYNTH",
        legalBasis: "synthetic-basis",
      })
    );
    const tx = await executeTool(undefined, (c) =>
      c.createDirectTransactionHistory({
        responderDomain: "holder.example",
        identifier: "wallet-synthetic-1",
        from: "2026-01-01",
        to: "2026-01-31",
        invstgtnId: "INV-SYNTH",
        legalBasis: "synthetic-basis",
      })
    );
    for (const result of [kyc, tx]) {
      expect(result.isError).toBe(true);
      const envelope = JSON.parse(result.content[0].text);
      expect(envelope.httpStatus).toBe(403);
      expect(envelope.body).toEqual(STRUCTURED_OFF);
      assertNoKey(result.content[0].text);
    }
    expect(calls.map((c) => c.url).sort()).toEqual(
      [`${BASE}/v1/requests/kyc`, `${BASE}/v1/requests/transaction-history`].sort()
    );
  });

  it("ARM-off free-text create and respond never surface ARM_STRUCTURED_NOT_ENABLED", async () => {
    const created = {
      requestId: "req-ft",
      workflowType: "INFORMATION",
      status: "SENT",
    };
    mockVanta(({ url, method }) => {
      if (method === "POST" && url.endsWith("/v1/requests/information")) {
        return { status: 201, json: created };
      }
      return { status: 500, json: { code: "UNEXPECTED_TEST_ROUTE" } };
    });
    const create = await executeTool(undefined, (c) =>
      c.createDirectInformation({
        responderDomain: "holder.example",
        request: "Please describe the relationship in plain language.",
        invstgtnId: "INV-SYNTH",
        legalBasis: "synthetic-basis",
      })
    );
    expect(create).not.toHaveProperty("isError");
    expect(create.content[0].text).not.toContain("ARM_STRUCTURED_NOT_ENABLED");
    expect(JSON.parse(create.content[0].text)).toEqual(created);

    const id = "req-ft";
    route(id, "INFORMATION_FOLLOWUP", {
      includes: "/v1/requests/req-ft/response",
      status: 200,
      json: { status: "RESPONDED", messageId: "msg-ft" },
    });
    const respond = await executeTool(undefined, (c) =>
      performRespond(c, id, { status: "COMP", freeText: "No structured fields." })
    );
    expect(respond).not.toHaveProperty("isError");
    expect(respond.content[0].text).not.toContain("ARM_STRUCTURED_NOT_ENABLED");
    const outcome = JSON.parse(respond.content[0].text) as { result: { status: string } };
    expect(outcome.result.status).toBe("RESPONDED");

    const io = captureIo();
    route(id, "INFORMATION_FOLLOWUP", {
      includes: "/response",
      status: 200,
      json: { status: "RESPONDED", messageId: "msg-ft" },
    });
    await runRespond("sandbox", id, {
      status: "COMP",
      freeText: "No structured fields.",
      yes: true,
      show: false,
    });
    io.restore();
    expect(io.stdout()).toContain("The server released this answer.");
    expect(io.stdout()).not.toContain("ARM_STRUCTURED_NOT_ENABLED");
    assertNoKey(io.stdout());
  });
});

describe("AC 6 — illegal structured fields on an information answer", () => {
  it("CLI posts accounts and returns 400 ARM_INFORMATION_STRUCTURED_FIELDS", async () => {
    const id = "req-info-acct";
    const calls = route(id, "INFORMATION_FOLLOWUP", {
      includes: `/v1/requests/${id}/response`,
      status: 400,
      json: ILLEGAL_FIELDS,
    });
    let thrown: unknown;
    try {
      await runRespond("sandbox", id, {
        status: "COMP",
        freeText: "plain",
        account: ["ACCOUNT:SYNTHETIC-1:IBAN:Demo"],
        yes: true,
        show: false,
      });
    } catch (e) {
      thrown = e;
    }
    const err = thrown as ReqportApiError;
    expect(err).toBeInstanceOf(ReqportApiError);
    expect(err.status).toBe(400);
    expect(apiErrorEnvelope(err).body).toEqual(ILLEGAL_FIELDS);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe(`${BASE}/v1/requests/${id}/response`);
    expect(post?.body).toMatchObject({
      status: "COMP",
      accounts: [{ instrumentType: "ACCOUNT", identifier: "SYNTHETIC-1", scheme: "IBAN", label: "Demo" }],
    });
    expect(calls).toHaveLength(2);

    const io = captureIo();
    reportCliError(err, true);
    io.restore();
    expect(JSON.parse(io.stdout()).body).toEqual(ILLEGAL_FIELDS);
    expect(io.stdout()).not.toMatch(/HOLD/);
    assertNoKey(io.stdout());
  });

  it("MCP posts an inline camt statement on information to /response and returns the 400", async () => {
    const id = "req-info-camt";
    const statement = { profile: "camt.053-CA", statementId: "stmt-synth", entries: [] };
    const calls = route(id, "UNSTRUCTURED_AUTHORITY_REQUEST_V1", {
      includes: `/v1/requests/${id}/response`,
      status: 400,
      json: { ...ILLEGAL_FIELDS, rejectedFields: ["statement"] },
    });
    const mcp = await executeTool(undefined, (c) => performRespond(c, id, { statement }));
    expect(mcp.isError).toBe(true);
    const envelope = JSON.parse(mcp.content[0].text);
    expect(envelope.httpStatus).toBe(400);
    expect(envelope.body.code).toBe("ARM_INFORMATION_STRUCTURED_FIELDS");
    expect(envelope.body.rejectedFields).toEqual(["statement"]);
    expect(envelope.body.steer).toEqual(STEER);
    expect(envelope.body.family).toBe("ARM");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/response");
    expect(post?.url).not.toContain("transaction-history-response");
    expect(post?.body).toMatchObject({ statement });
    expect(calls.some((c) => c.url.includes("/approve"))).toBe(false);
    assertNoKey(mcp.content[0].text);
  });

  it("does not rewrite an uncoded 403, and redacts a key that arrives in a body", () => {
    const plain = new ReqportApiError(403, "/v1/requests/x/response", "forbidden");
    expect(explainError(plain)).toMatch(/lacks the required scope/);

    const leaked = new ReqportApiError(
      403,
      "/v1/requests/x/response",
      JSON.stringify({ ...STRUCTURED_OFF, message: `see ${API_KEY}` })
    );
    const envelope = apiErrorEnvelope(leaked);
    expect(JSON.stringify(envelope)).not.toContain(API_KEY);
    expect(JSON.stringify(envelope)).toContain("[redacted]");
    expect((envelope.body as { code: string }).code).toBe("ARM_STRUCTURED_NOT_ENABLED");
    expect(explainError(leaked)).not.toContain(API_KEY);
  });
});

describe("help surfaces the server codes", () => {
  it("qp arm prints the ARM-off and reject codes", async () => {
    const io = captureIo();
    expect(await runArm()).toBe(0);
    io.restore();
    expect(io.stdout()).toContain("ARM_STRUCTURED_NOT_ENABLED");
    expect(io.stdout()).toContain("ARM_INFORMATION_STRUCTURED_FIELDS");
    expect(io.stdout()).toContain("GET arm-status");
  });

  it("qp respond --help names both codes", () => {
    const res = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "respond", "--help"], {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("ARM_STRUCTURED_NOT_ENABLED");
    expect(res.stdout).toContain("ARM_INFORMATION_STRUCTURED_FIELDS");
  });
});
