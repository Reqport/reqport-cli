/**
 * vanta#335 CONTENT_ACCESS_DENIED — nested error.code on decrypt-batch.
 * Synthetic fixtures only. No live tokens.
 */

import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialPath, credentialPathFor } from "../src/auth/paths.js";
import { loadCredential, saveCredential } from "../src/auth/store.js";
import { isLoggedIn } from "../src/auth/session.js";
import { ReqportApiError, ReqportClient } from "../src/client.js";
import { decodePayloads } from "../src/core.js";
import { executeTool } from "../src/mcp/server.js";
import { explainError, reportCliError } from "../src/ui.js";
import {
  CONTENT_ACCESS_DENIED_BODY,
  CONTENT_ACCESS_HUMAN,
  SYNTHETIC_API_KEY,
  SYNTHETIC_PAYLOAD_IDS,
} from "./fixtures/content-access-denied.js";
import { cleanupConfigDir, clearEnvKnobs, freshConfigDir, makeCred } from "./helpers.js";

const BASE = "https://vanta.test";
const DECRYPT_PATH = "/v1/payloads/decrypt-batch";
const SCOPE_HINT = "the key lacks the required scope, or your org is not a party to this request.";

type Call = { url: string; method: string; body?: unknown; authorization?: string };

function mockFetch(
  handler: (call: { url: string; method: string; body?: unknown }) => { status: number; json?: unknown; text?: string }
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
      const payload = res.json !== undefined ? JSON.stringify(res.json) : (res.text ?? "");
      return new Response(payload, {
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

function apiError(status: number, body: unknown, path = DECRYPT_PATH): ReqportApiError {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new ReqportApiError(status, path, raw);
}

function client(): ReqportClient {
  return new ReqportClient({
    env: "sandbox",
    baseUrl: BASE,
    credential: { value: SYNTHETIC_API_KEY, kind: "apikey" },
  });
}

function occurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}

let dir: string;

beforeEach(() => {
  dir = freshConfigDir();
  clearEnvKnobs();
});

afterEach(() => {
  cleanupConfigDir(dir);
  clearEnvKnobs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parser reads nested error.code and keeps legacy shapes", () => {
  it("reads nested error.code", () => {
    const err = apiError(403, CONTENT_ACCESS_DENIED_BODY);
    expect(err.code).toBe("CONTENT_ACCESS_DENIED");
    expect(err.status).toBe(403);
    expect(err.parsedBody).toEqual(CONTENT_ACCESS_DENIED_BODY);
    expect(CONTENT_ACCESS_DENIED_BODY).not.toHaveProperty("details");
    expect(CONTENT_ACCESS_DENIED_BODY.error).not.toHaveProperty("details");
  });

  it("keeps a top-level code ahead of a nested error.code", () => {
    const err = apiError(403, {
      code: "ARM_STRUCTURED_NOT_ENABLED",
      error: { code: "CONTENT_ACCESS_DENIED", message: "nested" },
    });
    expect(err.code).toBe("ARM_STRUCTURED_NOT_ENABLED");
  });

  it("keeps a string error as the code", () => {
    const err = apiError(403, { error: "insufficient_scope" });
    expect(err.code).toBe("insufficient_scope");
  });

  it("keeps a top-level errorCode when error is an object without a code", () => {
    const err = apiError(400, {
      errorCode: "PAYLOAD_NOT_FOUND",
      error: { message: "missing" },
    });
    expect(err.code).toBe("PAYLOAD_NOT_FOUND");
  });

  it("keeps a top-level errorCode ahead of a nested error.code", () => {
    const err = apiError(403, {
      errorCode: "LEGACY_CODE",
      error: { code: "CONTENT_ACCESS_DENIED", message: "nested" },
    });
    expect(err.code).toBe("LEGACY_CODE");
  });

  it("ignores an error array and an empty nested code", () => {
    expect(apiError(403, { error: [{ code: "CONTENT_ACCESS_DENIED" }] }).code).toBeUndefined();
    expect(apiError(403, { error: { code: "" } }).code).toBeUndefined();
    expect(apiError(403, { error: { message: "This content is not available to the caller." } }).code).toBeUndefined();
  });
});

describe("CONTENT_ACCESS_DENIED human output", () => {
  it("prints the administrator sentence and not the scope hint", () => {
    const nested = apiError(403, CONTENT_ACCESS_DENIED_BODY);
    const flat = apiError(403, { code: "CONTENT_ACCESS_DENIED", message: "This content is not available to the caller." });
    const asString = apiError(403, { error: "CONTENT_ACCESS_DENIED" });

    for (const err of [nested, flat, asString]) {
      expect(explainError(err)).toBe(CONTENT_ACCESS_HUMAN);
    }

    const io = captureIo();
    reportCliError(nested, false);
    io.restore();

    expect(io.stderr()).toBe(`Error: ${CONTENT_ACCESS_HUMAN}\n`);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).not.toContain(SCOPE_HINT);
    expect(io.stderr()).not.toContain("This content is not available to the caller.");
    expect(io.stderr()).not.toContain("HTTP 403");
    expect(io.stderr()).not.toContain(SYNTHETIC_API_KEY);
    expect(occurrences(io.stderr(), CONTENT_ACCESS_HUMAN)).toBe(1);
  });

  it("uses the same sentence for a mismatch and an unknown id", async () => {
    const mismatchIds = ["payload-mismatch-1"];
    const unknownIds = ["payload-unknown-1", "payload-unknown-2"];
    const seen: string[] = [];

    for (const ids of [mismatchIds, unknownIds]) {
      const calls = mockFetch(() => ({ status: 403, json: CONTENT_ACCESS_DENIED_BODY }));
      let thrown: unknown;
      try {
        await client().decryptBatch([...ids]);
      } catch (e) {
        thrown = e;
      }
      expect(calls).toHaveLength(1);
      expect(thrown).toBeInstanceOf(ReqportApiError);
      const err = thrown as ReqportApiError;
      expect(err.code).toBe("CONTENT_ACCESS_DENIED");
      seen.push(explainError(err));
      vi.unstubAllGlobals();
    }

    expect(seen).toEqual([CONTENT_ACCESS_HUMAN, CONTENT_ACCESS_HUMAN]);
  });
});

describe("CONTENT_ACCESS_DENIED leaves the session in place", () => {
  it("does not sign out or clear credentials", async () => {
    const cred = makeCred({
      env: "sandbox",
      value: SYNTHETIC_API_KEY,
      keyId: "key_fixture_access",
      scopes: ["payloads:read"],
    });
    saveCredential(cred);
    const activeBefore = readFileSync(credentialPath(), "utf-8");
    const perEnvBefore = readFileSync(credentialPathFor("sandbox"), "utf-8");
    expect(isLoggedIn()).toBe(true);

    mockFetch(() => ({ status: 403, json: CONTENT_ACCESS_DENIED_BODY }));
    await expect(client().decryptBatch([...SYNTHETIC_PAYLOAD_IDS])).rejects.toBeInstanceOf(ReqportApiError);

    const io = captureIo();
    reportCliError(apiError(403, CONTENT_ACCESS_DENIED_BODY), false);
    io.restore();

    expect(existsSync(credentialPath())).toBe(true);
    expect(existsSync(credentialPathFor("sandbox"))).toBe(true);
    expect(readFileSync(credentialPath(), "utf-8")).toBe(activeBefore);
    expect(readFileSync(credentialPathFor("sandbox"), "utf-8")).toBe(perEnvBefore);
    expect(loadCredential()?.value).toBe(SYNTHETIC_API_KEY);
    expect(isLoggedIn()).toBe(true);
    expect(io.stderr()).not.toMatch(/logout|signed out|cleared/i);
  });
});

describe("decrypt-batch refusal covers the whole batch", () => {
  it("prints the message once, not per item", async () => {
    process.env.REQPORT_API_KEY = SYNTHETIC_API_KEY;
    process.env.REQPORT_BASE_URL = BASE;
    process.env.REQPORT_ENV = "sandbox";

    const calls = mockFetch((call) => {
      expect(call.url).toBe(`${BASE}${DECRYPT_PATH}`);
      expect(call.method).toBe("POST");
      expect(call.body).toEqual({ payloadIds: [...SYNTHETIC_PAYLOAD_IDS] });
      return { status: 403, json: CONTENT_ACCESS_DENIED_BODY };
    });

    let thrown: unknown;
    try {
      await decodePayloads(client(), [...SYNTHETIC_PAYLOAD_IDS]);
    } catch (e) {
      thrown = e;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBe(`Bearer ${SYNTHETIC_API_KEY}`);
    expect(thrown).toBeInstanceOf(ReqportApiError);
    const err = thrown as ReqportApiError;
    expect(err.path).toBe(DECRYPT_PATH);
    expect(err.code).toBe("CONTENT_ACCESS_DENIED");

    const io = captureIo();
    reportCliError(err, false);
    io.restore();

    expect(io.stderr()).toBe(`Error: ${CONTENT_ACCESS_HUMAN}\n`);
    expect(occurrences(io.stderr(), CONTENT_ACCESS_HUMAN)).toBe(1);
    for (const id of SYNTHETIC_PAYLOAD_IDS) {
      expect(io.stderr()).not.toContain(id);
    }
    expect(io.stderr()).not.toContain(SCOPE_HINT);
    expect(io.stderr()).not.toContain(SYNTHETIC_API_KEY);

    const mcp = await executeTool("sandbox", (c) => decodePayloads(c, [...SYNTHETIC_PAYLOAD_IDS]));
    expect(mcp.isError).toBe(true);
    expect(mcp.content).toHaveLength(1);
    const text = mcp.content[0].text;
    expect(occurrences(text, "CONTENT_ACCESS_DENIED")).toBe(1);
    expect(text).not.toContain(SCOPE_HINT);
    expect(text).not.toContain(CONTENT_ACCESS_HUMAN);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ payloadIds: [...SYNTHETIC_PAYLOAD_IDS] });
  });
});

describe("--json stays the server envelope", () => {
  it("writes the nested body unchanged and skips the human sentence", () => {
    const err = apiError(403, CONTENT_ACCESS_DENIED_BODY);
    const io = captureIo();
    reportCliError(err, true);
    io.restore();

    expect(io.stderr()).toBe("");
    expect(JSON.parse(io.stdout())).toEqual({
      httpStatus: 403,
      path: DECRYPT_PATH,
      body: CONTENT_ACCESS_DENIED_BODY,
    });
    expect(io.stdout()).not.toContain(CONTENT_ACCESS_HUMAN);
    expect(io.stdout()).not.toContain(SCOPE_HINT);
    expect(io.stdout()).not.toContain(SYNTHETIC_API_KEY);
  });

  it("redacts a synthetic key that arrives inside the nested message", () => {
    const leaked = {
      error: {
        code: "CONTENT_ACCESS_DENIED",
        message: `see ${SYNTHETIC_API_KEY}`,
      },
    };
    const err = apiError(403, leaked);
    const io = captureIo();
    reportCliError(err, true);
    io.restore();
    expect(io.stdout()).not.toContain(SYNTHETIC_API_KEY);
    expect(io.stdout()).toContain("[redacted]");
    expect(JSON.parse(io.stdout()).body.error.code).toBe("CONTENT_ACCESS_DENIED");
    expect(explainError(err)).toBe(CONTENT_ACCESS_HUMAN);
    expect(explainError(err)).not.toContain(SYNTHETIC_API_KEY);
  });
});

describe("other codes keep their current hints", () => {
  it("leaves an uncoded 403 on the scope-or-party hint", () => {
    const plain = apiError(403, "forbidden");
    expect(plain.code).toBeUndefined();
    expect(explainError(plain)).toContain(SCOPE_HINT);
    expect(explainError(plain)).not.toContain(CONTENT_ACCESS_HUMAN);

    const messageOnly = apiError(403, { message: "no" });
    expect(messageOnly.code).toBeUndefined();
    expect(explainError(messageOnly)).toContain(SCOPE_HINT);
  });

  it("leaves 401, 404, and 503 hints in place", () => {
    expect(explainError(apiError(401, "unauthorized", "/v1/affordances"))).toContain(
      "check REQPORT_API_KEY is a valid rqk_live_ key for this --env."
    );
    expect(explainError(apiError(404, "missing", "/v1/workflows/fixture"))).toContain(
      "not found (wrong id or --env?)."
    );
    expect(explainError(apiError(503, "down", "/v1/attestation"))).toContain(
      "service says the operation is unavailable in this environment."
    );
  });

  it("renders a top-level ARM code as HTTP status plus JSON", () => {
    const body = {
      code: "ARM_STRUCTURED_NOT_ENABLED",
      family: "ARM",
      message: "Structured ARM is not enabled for this authority.",
    };
    const text = explainError(apiError(403, body, "/v1/requests/fixture/response"));
    expect(text).toContain("HTTP 403");
    expect(text).toContain("ARM_STRUCTURED_NOT_ENABLED");
    expect(text).toContain("Structured ARM is not enabled for this authority.");
    expect(text).not.toContain(SCOPE_HINT);
    expect(text).not.toContain(CONTENT_ACCESS_HUMAN);
  });

  it("renders a string error and a top-level errorCode as coded errors", () => {
    const asError = explainError(apiError(403, { error: "insufficient_scope" }));
    expect(asError).toContain("HTTP 403");
    expect(asError).toContain("insufficient_scope");
    expect(asError).not.toContain(SCOPE_HINT);
    expect(asError).not.toContain(CONTENT_ACCESS_HUMAN);

    const asErrorCode = explainError(apiError(400, { errorCode: "PAYLOAD_NOT_FOUND" }));
    expect(asErrorCode).toContain("HTTP 400");
    expect(asErrorCode).toContain("PAYLOAD_NOT_FOUND");
    expect(asErrorCode).not.toContain(CONTENT_ACCESS_HUMAN);
  });

  it("renders a nested code other than CONTENT_ACCESS_DENIED as HTTP status plus JSON", () => {
    const text = explainError(
      apiError(403, { error: { code: "NOT_A_MEMBER", message: "nope" } })
    );
    expect(text).toContain("HTTP 403");
    expect(text).toContain("NOT_A_MEMBER");
    expect(text).not.toContain(SCOPE_HINT);
    expect(text).not.toContain(CONTENT_ACCESS_HUMAN);
  });
});
