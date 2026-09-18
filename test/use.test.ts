import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEnv, runUse } from "../src/commands/use.js";
import { activeEnv } from "../src/auth/store.js";
import {
  cleanupConfigDir,
  clearEnvKnobs,
  freshConfigDir,
  makeCred,
  writeActiveCred,
  writePerEnvCred,
} from "./helpers.js";

let dir: string;
let out: string;
let restore: () => void;

function captureStdout(): void {
  out = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  const spyErr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  restore = () => {
    spy.mockRestore();
    spyErr.mockRestore();
  };
}

beforeEach(() => {
  dir = freshConfigDir();
  clearEnvKnobs();
  captureStdout();
});
afterEach(() => {
  restore();
  cleanupConfigDir(dir);
});

describe("qp use <env>", () => {
  it("switches the active env to a stored credential (by env)", () => {
    writeActiveCred(dir, makeCred({ env: "prod", baseUrl: "https://p/vanta" }));
    writePerEnvCred(
      dir,
      makeCred({ env: "dev-uat-sandbox", value: "rqk_live_twin0", baseUrl: "https://t/vanta" })
    );
    const code = runUse("dev-uat-sandbox", true);
    expect(code).toBe(0);
    expect(activeEnv()).toBe("dev-uat-sandbox");
    const json = JSON.parse(out);
    expect(json.ok).toBe(true);
    expect(json.activeEnv).toBe("dev-uat-sandbox");
    expect(json.baseUrl).toBe("https://t/vanta");
    // Never leak the raw key — only a masked form.
    expect(out).not.toContain("rqk_live_twin0");
    expect(json.apiKey).toMatch(/…/);
  });

  it("switches by estate label", () => {
    writePerEnvCred(dir, makeCred({ env: "prod", label: "Goobit Prod" }));
    const code = runUse("Goobit Prod", true);
    expect(code).toBe(0);
    expect(activeEnv()).toBe("prod");
  });

  it("errors clearly when no credential is stored for the env", () => {
    const code = runUse("prod", true);
    expect(code).toBe(1);
    const json = JSON.parse(out);
    expect(json.ok).toBe(false);
    expect(json.reason).toBe("no_credential");
  });
});

describe("qp env (list)", () => {
  it("lists stored + static envs, marks the active, and never prints the raw key", () => {
    writeActiveCred(
      dir,
      makeCred({ env: "prod", baseUrl: "https://vanta.reqport.com/vanta", keyId: "key_p" })
    );
    writePerEnvCred(
      dir,
      makeCred({ env: "prod", baseUrl: "https://vanta.reqport.com/vanta", keyId: "key_p" })
    );
    const code = runEnv(true);
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.activeEnv).toBe("prod");

    const byEnv = Object.fromEntries(json.environments.map((e: any) => [e.env, e]));
    // Every known static env is present.
    for (const env of ["sandbox", "uat", "prod", "dev-uat-sandbox"]) {
      expect(byEnv[env]).toBeDefined();
    }
    // The stored prod env is logged in + active; the rest are available to log into.
    expect(byEnv.prod.loggedIn).toBe(true);
    expect(byEnv.prod.active).toBe(true);
    expect(byEnv.sandbox.loggedIn).toBe(false);
    expect(byEnv["dev-uat-sandbox"].baseUrl).toBe(
      "https://dev-uat-sandbox.reqport.com/vanta"
    );
    // Raw key never appears anywhere in the output.
    expect(out).not.toContain(makeCred().value);
  });
});
