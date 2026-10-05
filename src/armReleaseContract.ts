/**
 * ARM release-id gate refusals from bots#10
 * (`eriko/docs/domain/arm-release-id-gate.md`).
 *
 * The CLI does not invent a second code. These are the only `ARM_RELEASE_*`
 * bodies this client maps. `ARM_RELEASE_NOT_RELEASED` is not a contract code.
 * JSON and MCP still return the server body unchanged; human text prints `message`.
 */

export const ARM_RELEASE_CODES = [
  "ARM_RELEASE_REQUIRED",
  "ARM_RELEASE_NOT_FOUND",
  "ARM_RELEASE_REQUEST_MISMATCH",
  "ARM_RELEASE_REPLAYED",
  "ARM_RELEASE_SUPERSEDED",
  "ARM_RELEASE_EXPIRED",
  "ARM_RELEASE_SHAPE_MISMATCH",
] as const;

export type ArmReleaseCode = (typeof ARM_RELEASE_CODES)[number];

export type ArmReleaseSteerBody = {
  code: ArmReleaseCode;
  family: "ARM";
  message: string;
  steer: { action: string; discovery: string };
};

/**
 * Steer bodies for the seven contract codes. REPLAYED tells the operator the
 * answer already went through — check status, do not send it again.
 */
export const ARM_RELEASE_BODIES: Record<ArmReleaseCode, ArmReleaseSteerBody> = {
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
};

export function isContractArmReleaseCode(code: string | undefined): code is ArmReleaseCode {
  return typeof code === "string" && (ARM_RELEASE_CODES as readonly string[]).includes(code);
}
