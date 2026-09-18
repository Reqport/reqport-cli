import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KNOWN_ENVS,
  baseUrlFor,
  credentialBaseUrl,
  isReqportEnv,
  resolveBaseUrl,
  resolveEnv,
} from "../src/env.js";
import {
  cleanupConfigDir,
  clearEnvKnobs,
  freshConfigDir,
  makeCred,
  writeActiveCred,
  writePerEnvCred,
} from "./helpers.js";

let dir: string;

beforeEach(() => {
  dir = freshConfigDir();
  clearEnvKnobs();
});
afterEach(() => cleanupConfigDir(dir));

describe("dev-uat-sandbox env", () => {
  it("is a recognised env", () => {
    expect(isReqportEnv("dev-uat-sandbox")).toBe(true);
    expect(KNOWN_ENVS).toContain("dev-uat-sandbox");
  });

  it("maps to the twin vanta URL in the static map", () => {
    expect(baseUrlFor("dev-uat-sandbox")).toBe(
      "https://dev-uat-sandbox.reqport.com/vanta"
    );
  });

  it("resolves via --env flag and REQPORT_ENV", () => {
    expect(resolveEnv("dev-uat-sandbox")).toBe("dev-uat-sandbox");
    process.env.REQPORT_ENV = "dev-uat-sandbox";
    expect(resolveEnv()).toBe("dev-uat-sandbox");
  });

  it("still rejects an unknown env", () => {
    expect(() => resolveEnv("does-not-exist")).toThrow(/Unknown --env/);
  });
});

describe("credentialBaseUrl", () => {
  it("prefers the credential's own baseUrl", () => {
    expect(
      credentialBaseUrl({ env: "prod", baseUrl: "https://custom.example/vanta/" })
    ).toBe("https://custom.example/vanta");
  });
  it("falls back to the static map for a canonical env without baseUrl", () => {
    expect(credentialBaseUrl({ env: "uat" })).toBe(
      "https://vanta.dev-uat.reqport.com/vanta"
    );
  });
  it("returns (unknown) for a non-canonical env without baseUrl", () => {
    expect(credentialBaseUrl({ env: "weird-estate" })).toBe("(unknown)");
  });
});

describe("resolveBaseUrl precedence", () => {
  it("1) REQPORT_BASE_URL override wins over everything", () => {
    writeActiveCred(dir, makeCred({ baseUrl: "https://vanta.reqport.com/vanta" }));
    process.env.REQPORT_BASE_URL = "https://override.example/vanta/";
    expect(resolveBaseUrl()).toBe("https://override.example/vanta");
    expect(resolveBaseUrl("prod")).toBe("https://override.example/vanta");
  });

  it("2) active stored credential's baseUrl wins over the static map", () => {
    writeActiveCred(
      dir,
      makeCred({ env: "prod", baseUrl: "https://minted.example/vanta" })
    );
    // No flag / REQPORT_ENV → the ACTIVE credential governs.
    expect(resolveBaseUrl()).toBe("https://minted.example/vanta");
  });

  it("2) --env-selected stored credential's baseUrl is used for that env", () => {
    writeActiveCred(dir, makeCred({ env: "prod", baseUrl: "https://prod.example/vanta" }));
    writePerEnvCred(
      dir,
      makeCred({
        env: "dev-uat-sandbox",
        value: "rqk_live_twin000000000000",
        baseUrl: "https://twin.example/vanta",
      })
    );
    // Selecting the twin env picks the twin cred's baseUrl, not prod's.
    expect(resolveBaseUrl("dev-uat-sandbox")).toBe("https://twin.example/vanta");
  });

  it("3) falls back to the static map when the selected env has no stored baseUrl", () => {
    // Active prod cred has no baseUrl; selecting dev-uat-sandbox (unstored)
    // falls through to the static map.
    writeActiveCred(dir, makeCred({ env: "prod" }));
    expect(resolveBaseUrl("dev-uat-sandbox")).toBe(
      "https://dev-uat-sandbox.reqport.com/vanta"
    );
  });

  it("3) falls back to the static map with no credential at all", () => {
    expect(resolveBaseUrl("sandbox")).toBe("https://sandbox.reqport.com/vanta");
  });
});
