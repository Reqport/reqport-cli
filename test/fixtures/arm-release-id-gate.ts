/**
 * Single shared fixture for the ARM release-id gate
 * (bots#10, `eriko/docs/domain/arm-release-id-gate.md`).
 *
 * Tests import this object. Production code does not define these bodies.
 * `Reqport/reqport-bots` returns HTTP 404 to this token, so the refusal
 * `message` and `steer` strings could not be copied out of that file.
 * They are the seven contract codes in the ARM envelope this suite posts.
 * `ARM_RELEASE_NOT_RELEASED` is not a contract code.
 *
 * Gate examples use `disposition`. AUTO_RELEASE and RELEASED carry `releaseId`
 * and `shape`. HOLD and DECLINE omit both.
 */

const shape = {
  slug: "information",
  itemModes: ["unstructured"],
  presence: { freeText: false, accounts: false },
  gateStamp: "synthetic-shape-1",
} as const;

export const ARM_RELEASE_ID_GATE = {
  shape,
  autoRelease: {
    disposition: "AUTO_RELEASE",
    releaseId: "armrel_synthetic_01",
    shape,
    messageId: "msg-auto",
  },
  released: {
    disposition: "RELEASED",
    releaseId: "armrel_synthetic_human",
    shape,
    messageId: "msg-human",
  },
  hold: {
    disposition: "HOLD",
  },
  decline: {
    disposition: "DECLINE",
    reason: "ruleset",
  },
  refusals: {
    ARM_RELEASE_REQUIRED: {
      code: "ARM_RELEASE_REQUIRED",
      family: "ARM",
      message: "Formal respond requires header X-Reqport-Arm-Release-Id.",
      steer: { action: "send-release-header", discovery: "POST /v1/requests/{id}/response" },
    },
    ARM_RELEASE_NOT_FOUND: {
      code: "ARM_RELEASE_NOT_FOUND",
      family: "ARM",
      message: "No ARM release exists for this id.",
      steer: { action: "obtain-release", discovery: "POST /v1/requests/{id}/response" },
    },
    ARM_RELEASE_REQUEST_MISMATCH: {
      code: "ARM_RELEASE_REQUEST_MISMATCH",
      family: "ARM",
      message: "This ARM release does not match the request.",
      steer: { action: "obtain-release", discovery: "POST /v1/requests/{id}/response" },
    },
    ARM_RELEASE_REPLAYED: {
      code: "ARM_RELEASE_REPLAYED",
      family: "ARM",
      message: "Already submitted. Check the request status.",
      steer: { action: "already-submitted", discovery: "GET /v1/workflows/{id}" },
    },
    ARM_RELEASE_SUPERSEDED: {
      code: "ARM_RELEASE_SUPERSEDED",
      family: "ARM",
      message: "A newer ARM release replaced this one.",
      steer: { action: "obtain-release", discovery: "POST /v1/requests/{id}/response" },
    },
    ARM_RELEASE_EXPIRED: {
      code: "ARM_RELEASE_EXPIRED",
      family: "ARM",
      message: "This ARM release has expired.",
      steer: { action: "obtain-release", discovery: "POST /v1/requests/{id}/response" },
    },
    ARM_RELEASE_SHAPE_MISMATCH: {
      code: "ARM_RELEASE_SHAPE_MISMATCH",
      family: "ARM",
      message: "Formal respond shape does not match the stored release shape.",
      steer: { action: "repeat-gate-shape", discovery: "POST /v1/requests/{id}/response" },
    },
  },
} as const;

export const ARM_RELEASE_CODES = Object.keys(ARM_RELEASE_ID_GATE.refusals);
