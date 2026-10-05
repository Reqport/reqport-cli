/**
 * Literal bots#10 gate fixtures (`eriko/docs/domain/arm-release-id-gate.md`).
 *
 * Messages and steer are the contract bodies. `armrel_EXAMPLE_NOT_A_SECRET`
 * is a placeholder in those examples, not a valid 22-character id. Tests that
 * put an id on the wire use {@link syntheticReleaseId}.
 */

const shape = {
  slug: "information",
  itemModes: ["unstructured"],
  presence: { accounts: false, statement: false },
} as const;

const declaredShape = {
  slug: "information",
  itemModes: ["unstructured"],
  presence: { accounts: true, statement: false },
} as const;

export const ARM_RELEASE_ID_PATTERN = /^armrel_[A-Za-z0-9_-]{22}$/;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Deterministic `armrel_` id with a 22-character body. Not the EXAMPLE placeholder. */
export function syntheticReleaseId(label: string): string {
  let state = 2166136261;
  const material = `synthetic:${label}`;
  for (let i = 0; i < material.length; i++) {
    state ^= material.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  let body = "";
  for (let i = 0; i < 22; i++) {
    state = Math.imul(state, 1664525) + 1013904223;
    body += ALPHABET[(state >>> 0) % ALPHABET.length];
  }
  return `armrel_${body}`;
}

export const ARM_RELEASE_ID_GATE = {
  idPattern: "^armrel_[A-Za-z0-9_-]{22}$",
  note: "armrel_EXAMPLE_NOT_A_SECRET is a placeholder, not a valid 22-char id — generate synthetic ids for tests",
  autoRelease: {
    disposition: "AUTO_RELEASE",
    releaseId: "armrel_EXAMPLE_NOT_A_SECRET",
    expiresAt: "2026-10-05T21:43:00Z",
    ttlSeconds: 120,
    requestId: "req_EXAMPLE",
    shape,
  },
  hold: {
    disposition: "HOLD_FOR_APPROVAL",
    requestId: "req_EXAMPLE",
    shape,
  },
  decline: {
    disposition: "DECLINE",
    requestId: "req_EXAMPLE",
    shape,
  },
  released: {
    disposition: "RELEASED",
    releaseId: "armrel_EXAMPLE_NOT_A_SECRET",
    expiresAt: "2026-10-05T21:45:00Z",
    ttlSeconds: 120,
    requestId: "req_EXAMPLE",
    shape,
  },
  refusals: {
    ARM_RELEASE_REQUIRED: {
      http: 403,
      body: {
        code: "ARM_RELEASE_REQUIRED",
        message:
          "No released gate decision for this formal answer. Run POST /v1/requests/{id}/response first. The answer was not sealed or sent.",
        steer: { family: "ARM", use: "shared-gate-first", gate: "POST /v1/requests/{id}/response" },
      },
    },
    ARM_RELEASE_NOT_FOUND: {
      http: 404,
      body: {
        code: "ARM_RELEASE_NOT_FOUND",
        message: "No usable release for this caller. The answer was not sealed or sent.",
        steer: { family: "ARM", use: "shared-gate-first", gate: "POST /v1/requests/{id}/response" },
      },
    },
    ARM_RELEASE_REQUEST_MISMATCH: {
      http: 403,
      body: {
        code: "ARM_RELEASE_REQUEST_MISMATCH",
        message: "This release is bound to a different request. The answer was not sealed or sent.",
        steer: { family: "ARM", use: "shared-gate-first", gate: "POST /v1/requests/{id}/response" },
      },
    },
    ARM_RELEASE_REPLAYED: {
      http: 409,
      body: {
        code: "ARM_RELEASE_REPLAYED",
        message: "This release was already used for an answer. The answer was not sealed or sent.",
        steer: { family: "ARM", use: "already-used" },
      },
    },
    ARM_RELEASE_SUPERSEDED: {
      http: 403,
      body: {
        code: "ARM_RELEASE_SUPERSEDED",
        message:
          "This release was superseded by a later decision. Use the release id from that decision. The answer was not sealed or sent.",
        steer: { family: "ARM", use: "release-superseded", gate: "POST /v1/requests/{id}/response" },
      },
    },
    ARM_RELEASE_EXPIRED: {
      http: 403,
      body: {
        code: "ARM_RELEASE_EXPIRED",
        message:
          "This release expired. Run the shared gate again to mint a new release. The answer was not sealed or sent.",
        steer: { family: "ARM", use: "release-expired", gate: "POST /v1/requests/{id}/response" },
      },
    },
    ARM_RELEASE_SHAPE_MISMATCH: {
      http: 409,
      body: {
        code: "ARM_RELEASE_SHAPE_MISMATCH",
        message: "Declared shape does not match the shape that was released. The answer was not sealed or sent.",
        steer: { family: "ARM", use: "shape-must-match-release" },
        releasedShape: shape,
        declaredShape,
      },
    },
  },
} as const;

export const ARM_RELEASE_CODES = Object.keys(ARM_RELEASE_ID_GATE.refusals);
