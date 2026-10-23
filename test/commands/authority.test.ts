/**
 * Unit tests for `qp authority` commands.
 *
 * ReqportClient is mocked via vi.mock so no HTTP calls are made.
 * requireResponderCredential is mocked to return a stub credential.
 * Stdout is captured to assert on printed output.
 *
 * vitest 5 requires constructor mocks to use `function` (not arrow functions),
 * because arrow functions cannot be invoked with `new`. Each
 * mockImplementationOnce uses `function () { return {...}; }` for this reason.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "../../src/types.js";
import { clearEnvKnobs } from "../helpers.js";

// ── Module-level mocks (hoisted before imports) ──────────────────────────────

// vitest 5: use importOriginal so real exports like `redactValue` are preserved;
// we only override ReqportClient with a spy constructor.
vi.mock(import("../../src/client.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ReqportClient: vi.fn().mockImplementation(function () {
      return {
        proposeAuthority: vi.fn(),
        listAuthorityReview: vi.fn(),
        approveAuthorityReview: vi.fn(),
      };
    }),
  };
});

vi.mock("../../src/auth/session.js", () => ({
  requireResponderCredential: vi.fn().mockResolvedValue({
    value: "rqk_live_testkey",
    kind: "apikey",
  }),
}));

// ── Deferred imports (after vi.mock so they receive the mocked versions) ─────

import { ReqportClient } from "../../src/client.js";
import {
  runAuthorityApprove,
  runAuthorityListPending,
  runAuthorityPropose,
} from "../../src/commands/authority.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SAMPLE_ITEM: ReviewItem = {
  id: "rev-1234-abcd",
  kind: "AUTHORITY_INTAKE",
  summary: "Polisen — polisen.se [SE]",
  status: "PENDING",
  proposedByPrincipalId: "usr-abc",
  proposedAt: "2026-10-23T10:00:00Z",
  proposedByMe: false,
};

/** Returns the mock instance created by the most recent `new ReqportClient()`. */
function lastMockClient() {
  const ctor = vi.mocked(ReqportClient);
  const lastCall = ctor.mock.results.at(-1);
  if (!lastCall || lastCall.type !== "return") {
    throw new Error("ReqportClient was not constructed in this test");
  }
  return lastCall.value as {
    proposeAuthority: ReturnType<typeof vi.fn>;
    listAuthorityReview: ReturnType<typeof vi.fn>;
    approveAuthorityReview: ReturnType<typeof vi.fn>;
  };
}

let out: string;
let restoreStdout: () => void;

function captureStdout(): void {
  out = "";
  const spyOut = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  restoreStdout = () => {
    spyOut.mockRestore();
    spyErr.mockRestore();
  };
}

beforeEach(() => {
  clearEnvKnobs();
  vi.clearAllMocks();
  captureStdout();
});

afterEach(() => {
  restoreStdout();
});

// ── propose ───────────────────────────────────────────────────────────────────

describe("qp authority propose", () => {
  it("calls proposeAuthority with the correct intake shape and prints the id", async () => {
    vi.mocked(ReqportClient).mockImplementationOnce(function () {
      return {
        proposeAuthority: vi.fn().mockResolvedValue(SAMPLE_ITEM),
        listAuthorityReview: vi.fn(),
        approveAuthorityReview: vi.fn(),
      };
    });

    const code = await runAuthorityPropose("sandbox", {
      domain: "polisen.se",
      name: "Polisen",
      country: "SE",
      source: "https://polisen.se",
      riskTier: "STANDARD",
      json: false,
    });

    expect(code).toBe(0);
    const mock = lastMockClient();
    expect(mock.proposeAuthority).toHaveBeenCalledOnce();
    expect(mock.proposeAuthority).toHaveBeenCalledWith({
      domain: "polisen.se",
      agencyName: "Polisen",
      countryCode: "SE",
      sourceUrl: "https://polisen.se",
      riskTier: "STANDARD",
    });
    expect(out).toContain("rev-1234-abcd");
    expect(out).toContain("qp authority approve rev-1234-abcd");
  });

  it("defaults country to EU and riskTier to STANDARD when not provided", async () => {
    vi.mocked(ReqportClient).mockImplementationOnce(function () {
      return {
        proposeAuthority: vi.fn().mockResolvedValue(SAMPLE_ITEM),
        listAuthorityReview: vi.fn(),
        approveAuthorityReview: vi.fn(),
      };
    });

    await runAuthorityPropose("sandbox", {
      domain: "example.eu",
      name: "Test Agency",
      source: "https://example.eu",
      json: false,
    });

    const mock = lastMockClient();
    expect(mock.proposeAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: "EU", riskTier: "STANDARD" })
    );
  });

  it("prints JSON when --json is set", async () => {
    vi.mocked(ReqportClient).mockImplementationOnce(function () {
      return {
        proposeAuthority: vi.fn().mockResolvedValue(SAMPLE_ITEM),
        listAuthorityReview: vi.fn(),
        approveAuthorityReview: vi.fn(),
      };
    });

    const code = await runAuthorityPropose("sandbox", {
      domain: "polisen.se",
      name: "Polisen",
      source: "https://polisen.se",
      json: true,
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe("rev-1234-abcd");
  });
});

// ── list-pending ──────────────────────────────────────────────────────────────

describe("qp authority list-pending", () => {
  it("calls listAuthorityReview('PENDING') and prints the table", async () => {
    const items: ReviewItem[] = [
      { ...SAMPLE_ITEM, proposedByMe: true },
      { ...SAMPLE_ITEM, id: "rev-5678-wxyz", proposedByMe: false },
    ];
    vi.mocked(ReqportClient).mockImplementationOnce(function () {
      return {
        proposeAuthority: vi.fn(),
        listAuthorityReview: vi.fn().mockResolvedValue(items),
        approveAuthorityReview: vi.fn(),
      };
    });

    const code = await runAuthorityListPending("sandbox", { json: false });

    expect(code).toBe(0);
    const mock = lastMockClient();
    expect(mock.listAuthorityReview).toHaveBeenCalledWith("PENDING");
    expect(out).toContain("rev-1234-abcd");
    expect(out).toContain("rev-5678-wxyz");
    // proposedByMe=true row shows "(you)"
    expect(out).toContain("(you)");
  });

  it("passes a custom status filter to listAuthorityReview", async () => {
    vi.mocked(ReqportClient).mockImplementationOnce(function () {
      return {
        proposeAuthority: vi.fn(),
        listAuthorityReview: vi.fn().mockResolvedValue([]),
        approveAuthorityReview: vi.fn(),
      };
    });

    await runAuthorityListPending("sandbox", { status: "APPROVED", json: false });

    const mock = lastMockClient();
    expect(mock.listAuthorityReview).toHaveBeenCalledWith("APPROVED");
  });

  it("prints an empty-queue message when no items are returned", async () => {
    vi.mocked(ReqportClient).mockImplementationOnce(function () {
      return {
        proposeAuthority: vi.fn(),
        listAuthorityReview: vi.fn().mockResolvedValue([]),
        approveAuthorityReview: vi.fn(),
      };
    });

    const code = await runAuthorityListPending("sandbox", { json: false });

    expect(code).toBe(0);
    expect(out).toContain("No items with status PENDING");
  });

  it("prints JSON when --json is set", async () => {
    vi.mocked(ReqportClient).mockImplementationOnce(function () {
      return {
        proposeAuthority: vi.fn(),
        listAuthorityReview: vi.fn().mockResolvedValue([SAMPLE_ITEM]),
        approveAuthorityReview: vi.fn(),
      };
    });

    const code = await runAuthorityListPending("sandbox", { json: true });

    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe("rev-1234-abcd");
  });
});

// ── approve ───────────────────────────────────────────────────────────────────

describe("qp authority approve", () => {
  it("calls approveAuthorityReview(id) and prints the approved item", async () => {
    const approved: ReviewItem = {
      ...SAMPLE_ITEM,
      status: "APPROVED",
      decidedAt: "2026-10-23T11:00:00Z",
      decidedByPrincipalId: "usr-xyz",
    };
    vi.mocked(ReqportClient).mockImplementationOnce(function () {
      return {
        proposeAuthority: vi.fn(),
        listAuthorityReview: vi.fn(),
        approveAuthorityReview: vi.fn().mockResolvedValue(approved),
      };
    });

    const code = await runAuthorityApprove("sandbox", "rev-1234-abcd", { json: false });

    expect(code).toBe(0);
    const mock = lastMockClient();
    expect(mock.approveAuthorityReview).toHaveBeenCalledWith("rev-1234-abcd");
    expect(out).toContain("rev-1234-abcd");
    expect(out).toContain("APPROVED");
    expect(out).toContain("approved successfully");
  });

  it("prints JSON when --json is set", async () => {
    const approved: ReviewItem = { ...SAMPLE_ITEM, status: "APPROVED" };
    vi.mocked(ReqportClient).mockImplementationOnce(function () {
      return {
        proposeAuthority: vi.fn(),
        listAuthorityReview: vi.fn(),
        approveAuthorityReview: vi.fn().mockResolvedValue(approved),
      };
    });

    const code = await runAuthorityApprove("sandbox", "rev-1234-abcd", { json: true });

    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("APPROVED");
  });
});
