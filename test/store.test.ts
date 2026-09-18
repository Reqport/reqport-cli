import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateEnv,
  activeEnv,
  listStoredCredentials,
  listStoredEnvs,
  loadCredential,
  loadCredentialFor,
  resolveStoredSelector,
  saveCredential,
} from "../src/auth/store.js";
import {
  cleanupConfigDir,
  clearEnvKnobs,
  freshConfigDir,
  makeCred,
  writePerEnvCred,
} from "./helpers.js";

let dir: string;

beforeEach(() => {
  dir = freshConfigDir();
  clearEnvKnobs();
});
afterEach(() => cleanupConfigDir(dir));

describe("store round-trip with baseUrl + label", () => {
  it("persists and reads back baseUrl and label", () => {
    saveCredential(
      makeCred({
        env: "prod",
        baseUrl: "https://vanta.reqport.com/vanta",
        label: "Goobit Prod",
        keyId: "key_1",
        scopes: ["responses:read"],
      })
    );
    const active = loadCredential();
    expect(active?.baseUrl).toBe("https://vanta.reqport.com/vanta");
    expect(active?.label).toBe("Goobit Prod");
    expect(activeEnv()).toBe("prod");

    const perEnv = loadCredentialFor("prod");
    expect(perEnv?.baseUrl).toBe("https://vanta.reqport.com/vanta");
    expect(perEnv?.label).toBe("Goobit Prod");
  });

  it("backward-compatible: an old credential without baseUrl/label still loads", () => {
    writePerEnvCred(dir, makeCred({ env: "uat" })); // no baseUrl/label
    const c = loadCredentialFor("uat");
    expect(c?.env).toBe("uat");
    expect(c?.baseUrl).toBeUndefined();
    expect(c?.label).toBeUndefined();
  });
});

describe("listStoredCredentials / listStoredEnvs", () => {
  it("lists one credential per stored env", () => {
    writePerEnvCred(dir, makeCred({ env: "prod", baseUrl: "https://p/vanta" }));
    writePerEnvCred(
      dir,
      makeCred({ env: "dev-uat-sandbox", value: "rqk_live_twin0", baseUrl: "https://t/vanta" })
    );
    expect(listStoredEnvs().sort()).toEqual(["dev-uat-sandbox", "prod"]);
    const creds = listStoredCredentials();
    expect(creds.map((c) => c.env).sort()).toEqual(["dev-uat-sandbox", "prod"]);
  });
});

describe("resolveStoredSelector", () => {
  it("matches by env", () => {
    writePerEnvCred(dir, makeCred({ env: "prod" }));
    expect(resolveStoredSelector("prod")).toBe("prod");
  });
  it("matches by label", () => {
    writePerEnvCred(dir, makeCred({ env: "prod", label: "Goobit Prod" }));
    expect(resolveStoredSelector("Goobit Prod")).toBe("prod");
  });
  it("returns undefined when nothing matches", () => {
    writePerEnvCred(dir, makeCred({ env: "prod" }));
    expect(resolveStoredSelector("sandbox")).toBeUndefined();
  });
});

describe("activateEnv switching", () => {
  it("promotes the per-env credential to active", () => {
    writePerEnvCred(dir, makeCred({ env: "prod", baseUrl: "https://p/vanta" }));
    writePerEnvCred(
      dir,
      makeCred({ env: "dev-uat-sandbox", value: "rqk_live_twin0", baseUrl: "https://t/vanta" })
    );
    // Nothing active yet.
    expect(activeEnv()).toBeUndefined();

    const promoted = activateEnv("dev-uat-sandbox");
    expect(promoted?.env).toBe("dev-uat-sandbox");
    expect(activeEnv()).toBe("dev-uat-sandbox");
    expect(loadCredential()?.baseUrl).toBe("https://t/vanta");

    // Switch to prod.
    expect(activateEnv("prod")?.env).toBe("prod");
    expect(activeEnv()).toBe("prod");
  });

  it("returns undefined for an env with no stored credential", () => {
    expect(activateEnv("prod")).toBeUndefined();
  });
});
