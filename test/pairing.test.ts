import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { runPairing, buildVerificationUrl } from "../src/auth/pairing.js";

const PORTAL = "https://portal.example";
const DEVICE_CODE = "DEVICE-CODE-SECRET-abc123";
const API_KEY = "rqk_live_supersecretkey0123456789";

const BEGIN_OK = {
  device_code: DEVICE_CODE,
  user_code: "ABCD-EFGH",
  verification_uri: `${PORTAL}/en/developer/cli-auth`,
  expires_in: 300,
  interval: 2,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Call = { url: string; body: any };

function harness(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const f = vi.fn(async (input: any, init?: any) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(init.body) : undefined });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const messages: string[] = [];
  const opened: string[] = [];
  const deps = {
    fetch: f as unknown as typeof fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    open: (u: string) => {
      opened.push(u);
    },
  };
  return { calls, sleeps, messages, opened, deps, progress: (m: string) => messages.push(m) };
}

const READY = {
  status: "ready",
  apiKey: API_KEY,
  keyId: "key_1",
  env: "sandbox",
  envLabel: "sandbox",
  vantaBaseUrl: "https://sandbox.reqport.com/vanta",
  scopes: ["responses:write"],
  expiresAt: null,
};

afterEach(() => vi.restoreAllMocks());

describe("device-code pairing: begin", () => {
  it("sends {challenge, env, name} only; poll verifier hashes to the challenge", async () => {
    const h = harness([json(200, BEGIN_OK), json(200, READY)]);
    await runPairing({ portalUrl: PORTAL + "/", env: "sandbox", name: "my-laptop" }, h.progress, h.deps);
    const begin = h.calls[0];
    expect(begin.url).toBe(`${PORTAL}/api/developer/cli-auth/begin`);
    expect(Object.keys(begin.body).sort()).toEqual(["challenge", "env", "name"]);
    expect(begin.body.env).toBe("sandbox");
    expect(begin.body.name).toBe("my-laptop");
    expect(begin.body).not.toHaveProperty("state");
    const poll = h.calls[1];
    expect(poll.url).toBe(`${PORTAL}/api/developer/cli-auth/poll`);
    expect(Object.keys(poll.body).sort()).toEqual(["device_code", "verifier"]);
    expect(poll.body.device_code).toBe(DEVICE_CODE);
    expect(createHash("sha256").update(poll.body.verifier).digest("base64url")).toBe(begin.body.challenge);
  });

  it("prints the user_code and opens the URI with ONLY user_code appended", async () => {
    const h = harness([json(200, BEGIN_OK), json(200, READY)]);
    await runPairing({ portalUrl: PORTAL, env: "prod" }, h.progress, h.deps);
    expect(h.messages[0]).toContain("Confirm this code in your browser: ABCD-EFGH");
    expect(h.opened).toHaveLength(1);
    const u = new URL(h.opened[0]);
    expect(`${u.origin}${u.pathname}`).toBe(BEGIN_OK.verification_uri);
    expect([...u.searchParams.keys()]).toEqual(["user_code"]);
    expect(u.searchParams.get("user_code")).toBe("ABCD-EFGH");
    expect(h.opened[0]).not.toMatch(/state|challenge|verifier|device_code/);
  });

  it("buildVerificationUrl uses the URI as given", () => {
    expect(buildVerificationUrl("https://x.test/en/developer/cli-auth", "ABCD-EFGH")).toBe(
      "https://x.test/en/developer/cli-auth?user_code=ABCD-EFGH"
    );
  });

  it("old portal (404 on begin) fails clearly and never falls back", async () => {
    const h = harness([json(404, { error: "Not found" })]);
    await expect(runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, h.deps)).rejects.toThrow(
      /too old/
    );
    expect(h.calls).toHaveLength(1);
    expect(h.opened).toHaveLength(0);
    expect(h.messages).toHaveLength(0);
  });

  it("429 on begin backs off and retries, then succeeds", async () => {
    const h = harness([json(429, { error: "rate_limited" }), json(429, {}), json(200, BEGIN_OK), json(200, READY)]);
    const r = await runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, h.deps);
    expect(r.apiKey).toBe(API_KEY);
    expect(h.sleeps.slice(0, 2)).toEqual([2000, 4000]);
  });

  it("gives a clear message after repeated 429 on begin", async () => {
    const h = harness([json(429, {}), json(429, {}), json(429, {}), json(429, {})]);
    await expect(runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, h.deps)).rejects.toThrow(
      /rate-limiting/
    );
    expect(h.calls).toHaveLength(4);
  });

  it("503 busy and 400 invalid are clear errors", async () => {
    await expect(
      runPairing({ portalUrl: PORTAL, env: "sandbox" }, () => {}, harness([json(503, { error: "busy" })]).deps)
    ).rejects.toThrow(/busy/);
    await expect(
      runPairing(
        { portalUrl: PORTAL, env: "nope" },
        () => {},
        harness([json(400, { error: "env must be sandbox or prod." })]).deps
      )
    ).rejects.toThrow(/rejected.*env must be sandbox or prod/);
  });

  it("rejects a malformed user_code or non-http verification_uri", async () => {
    await expect(
      runPairing(
        { portalUrl: PORTAL, env: "sandbox" },
        () => {},
        harness([json(200, { ...BEGIN_OK, user_code: "\u001b[31mEVIL" })]).deps
      )
    ).rejects.toThrow(/malformed/);
    await expect(
      runPairing(
        { portalUrl: PORTAL, env: "sandbox" },
        () => {},
        harness([json(200, { ...BEGIN_OK, verification_uri: "file:///etc/passwd" })]).deps
      )
    ).rejects.toThrow(/invalid verification URL/);
  });
});

describe("device-code pairing: poll loop", () => {
  it("202, 202, 200 returns the key, sleeping `interval` between polls", async () => {
    const h = harness([
      json(200, BEGIN_OK),
      json(202, { status: "pending" }),
      json(202, { status: "pending" }),
      json(200, READY),
    ]);
    const r = await runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, h.deps);
    expect(r).toMatchObject({ apiKey: API_KEY, keyId: "key_1", env: "sandbox", scopes: ["responses:write"] });
    expect(h.sleeps).toEqual([2000, 2000]);
  });

  it("410 expired stops with a rerun hint", async () => {
    const h = harness([json(200, BEGIN_OK), json(410, { status: "expired" })]);
    await expect(runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, h.deps)).rejects.toThrow(
      /expired.*qp login/
    );
    expect(h.calls).toHaveLength(2);
  });

  it("410 consumed stops", async () => {
    const h = harness([json(200, BEGIN_OK), json(410, { status: "consumed" })]);
    await expect(runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, h.deps)).rejects.toThrow(
      /already used.*qp login/
    );
  });

  it("410 cli_update_required and 403 bad_verifier stop", async () => {
    await expect(
      runPairing(
        { portalUrl: PORTAL, env: "sandbox" },
        () => {},
        harness([json(200, BEGIN_OK), json(410, { status: "cli_update_required" })]).deps
      )
    ).rejects.toThrow(/newer qp/);
    await expect(
      runPairing(
        { portalUrl: PORTAL, env: "sandbox" },
        () => {},
        harness([json(200, BEGIN_OK), json(403, { status: "bad_verifier" })]).deps
      )
    ).rejects.toThrow(/verifier mismatch/);
  });

  it("429 on poll backs off exponentially then continues", async () => {
    const h = harness([
      json(200, BEGIN_OK),
      json(429, { status: "rate_limited" }),
      json(429, { status: "rate_limited" }),
      json(202, {}),
      json(200, READY),
    ]);
    const r = await runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, h.deps);
    expect(r.apiKey).toBe(API_KEY);
    expect(h.sleeps).toEqual([4000, 8000, 2000]);
  });

  it("transient network error / 5xx on poll keeps polling", async () => {
    const h = harness([json(200, BEGIN_OK), new Error("ECONNRESET"), json(502, {}), json(200, READY)]);
    const r = await runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, h.deps);
    expect(r.apiKey).toBe(API_KEY);
  });

  it("gives up after expires_in", async () => {
    const pending = () => json(202, { status: "pending" });
    const h = harness([
      json(200, { ...BEGIN_OK, expires_in: 0.05, interval: 1 }),
      ...Array.from({ length: 200 }, pending),
    ]);
    const deps = { ...h.deps, sleep: () => new Promise<void>((r) => setTimeout(r, 10)) };
    await expect(runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, deps)).rejects.toThrow(
      /timed out/
    );
  });
});

describe("device-code pairing: no secrets leak", () => {
  it("never prints/logs device_code, verifier or the API key", async () => {
    const out: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void out.push(a.join(" ")))
    );
    const w1 = vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => (out.push(String(c)), true)) as any);
    const w2 = vi.spyOn(process.stderr, "write").mockImplementation(((c: any) => (out.push(String(c)), true)) as any);

    const h = harness([json(200, BEGIN_OK), json(202, {}), json(200, READY)]);
    await runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, h.deps);
    const verifier = h.calls[1].body.verifier as string;

    const everything = [...out, ...h.messages, ...h.opened].join("\n");
    expect(everything).not.toContain(DEVICE_CODE);
    expect(everything).not.toContain(verifier);
    expect(everything).not.toContain(API_KEY);
    spies.forEach((s) => s.mockRestore());
    w1.mockRestore();
    w2.mockRestore();
  });

  it("error messages do not contain secrets", async () => {
    const h = harness([json(200, BEGIN_OK), json(403, { status: "bad_verifier" })]);
    const e = await runPairing({ portalUrl: PORTAL, env: "sandbox" }, h.progress, h.deps).catch((x) => x as Error);
    expect(e.message).not.toContain(DEVICE_CODE);
    expect(e.message).not.toContain(h.calls[1].body.verifier);
  });
});
