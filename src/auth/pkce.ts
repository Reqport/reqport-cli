/**
 * PKCE (RFC 7636) + random state, using node:crypto. The verifier is a
 * high-entropy random string; the challenge is BASE64URL(SHA256(verifier)).
 */

import { createHash, randomBytes } from "node:crypto";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type Pkce = { verifier: string; challenge: string; method: "S256" };

export function createPkce(): Pkce {
  const verifier = base64url(randomBytes(32)); // 43-char URL-safe verifier
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function randomState(): string {
  return base64url(randomBytes(16));
}
