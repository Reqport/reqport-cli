/**
 * ARM v0.1 machine-surface copy shared by CLI help and MCP tool docs.
 *
 * The codes and the steer are the server's (vanta). This module does not decide
 * HOLD / decline / ARM-on, and it does not invent a second error taxonomy.
 */

/** One-line contract for `qp --help` and MCP tool descriptions. */
export const ARM_SURFACE_BRIEF =
  "The server applies the requestor ruleset; this client never releases an answer the ruleset would hold or decline. " +
  "When authorityArmEnabled is false, free-text create/respond stay available and do not return ARM_STRUCTURED_NOT_ENABLED; " +
  "structured create/respond return HTTP 403 ARM_STRUCTURED_NOT_ENABLED. " +
  "Accounts, an inline statement, or camt on an information answer return HTTP 400 ARM_INFORMATION_STRUCTURED_FIELDS. " +
  "Both carry the server steer (family ARM, use free-text or enable, discovery GET arm-status; rejectedFields on the 400). " +
  "CLI --json and MCP return that body unchanged. " +
  "A released disposition (AUTO_RELEASE or RELEASED) that includes releaseId is forwarded with the gate shape unchanged, as header X-Reqport-Arm-Release-Id on POST /v3/workflows/{id}/respond. " +
  "That formal call is a single attempt and is not retried. The full release id is sent only on that header. " +
  "Logs, errors, JSON, and other output show the armrel_ prefix (armrel_…). An id without that prefix is [redacted]. HOLD and DECLINE send neither the header nor a shape. " +
  "ARM_RELEASE_* errors print the server message and pass steer through. Each refusal says the answer was not sealed or sent. ARM_RELEASE_REPLAYED uses steer already-used; check the request status before trying again.";

/** How the server classified a 2xx response body. Never inferred locally. */
export type ServerDecision = "released" | "held" | "declined" | "unspecified";

/**
 * Server enums this client already speaks. Match is exact (case-sensitive),
 * so NOT_SENT is not SENT and UNRELEASED is not a release.
 *
 * Held wins over decline, and decline wins over release, when a body carries
 * more than one of these tokens.
 */
const HELD_STATES: ReadonlySet<string> = new Set(["HOLD", "HOLD_FOR_APPROVAL", "PENDING_APPROVAL"]);
const DECLINED_STATES: ReadonlySet<string> = new Set(["DECLINE", "DECLINED", "RESPONSE_DECLINED"]);
/**
 * AUTO_RELEASE and RESPONDED are the ruleset/response tokens from Gap 6.
 * RELEASED is the human approve token, matched exactly (not as a substring),
 * so UNRELEASED stays unspecified.
 */
const RELEASED_STATES: ReadonlySet<string> = new Set(["AUTO_RELEASE", "RESPONDED", "RELEASED"]);

function enumToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token === "" ? undefined : token;
}

function classifyToken(token: string): ServerDecision | undefined {
  if (HELD_STATES.has(token)) return "held";
  if (DECLINED_STATES.has(token)) return "declined";
  if (RELEASED_STATES.has(token)) return "released";
  return undefined;
}

/**
 * Read the server decision. `disposition` is authoritative when present
 * (`AUTO_RELEASE`, `RELEASED`, `HOLD`, `DECLINE`, …). Legacy `status` /
 * `approvalState` / `action` are used only when disposition is absent.
 * Anything else is unspecified — this function does not guess.
 */
export function serverDecision(result: {
  disposition?: unknown;
  status?: unknown;
  approvalState?: unknown;
  action?: unknown;
}): ServerDecision {
  const disposition = enumToken(result.disposition);
  if (disposition !== undefined) {
    return classifyToken(disposition) ?? "unspecified";
  }
  const tokens = [enumToken(result.status), enumToken(result.approvalState), enumToken(result.action)].filter(
    (token): token is string => token !== undefined
  );
  if (tokens.length === 0) return "unspecified";
  if (tokens.some((token) => HELD_STATES.has(token))) return "held";
  if (tokens.some((token) => DECLINED_STATES.has(token))) return "declined";
  if (tokens.some((token) => RELEASED_STATES.has(token))) return "released";
  return "unspecified";
}

/** Header vanta requires on the encrypted v3 formal respond. */
export const ARM_RELEASE_ID_HEADER = "X-Reqport-Arm-Release-Id";

/** Contract prefix. Output may show this. It must not show the rest of the token. */
export const ARM_RELEASE_ID_PREFIX = "armrel_";

const ARMREL_TOKEN = /armrel_[A-Za-z0-9_-]+/g;

/**
 * releaseId from a gate body, only when the server decision is released.
 * HOLD, DECLINE, and unknown tokens yield undefined even if a releaseId is present.
 */
export function releasedArmReleaseId(result: {
  disposition?: unknown;
  status?: unknown;
  approvalState?: unknown;
  action?: unknown;
  releaseId?: unknown;
}): string | undefined {
  if (serverDecision(result) !== "released") return undefined;
  if (typeof result.releaseId !== "string") return undefined;
  const releaseId = result.releaseId.trim();
  return releaseId === "" ? undefined : releaseId;
}

/** True for vanta's ARM release-gate codes (ARM_RELEASE_REQUIRED, and the rest of that family). */
export function isArmReleaseErrorCode(code: string | undefined): boolean {
  return typeof code === "string" && code.startsWith("ARM_RELEASE_");
}

/** Visible prefix for a release id. The rest of the token is never shown. */
export const ARM_RELEASE_ID_VISIBLE = "armrel_…";

/** Fixed marker for a release id that has no `armrel_` prefix. Not a hash. */
export const RELEASE_ID_REDACTED = "[redacted]";

/**
 * Visible form of a release id. The full token is allowed only on
 * `X-Reqport-Arm-Release-Id`. Everywhere else this is `armrel_…`, or
 * `[redacted]` when the id has no `armrel_` prefix.
 */
export function displayReleaseId(releaseId: string): string {
  const id = releaseId.trim();
  if (id.startsWith(ARM_RELEASE_ID_PREFIX)) return ARM_RELEASE_ID_VISIBLE;
  return RELEASE_ID_REDACTED;
}

/** Replace any `armrel_…` token in text with the prefix. Leaves a bare `armrel_` as-is. */
export function redactReleaseIdText(s: string): string {
  return s.replace(ARMREL_TOKEN, () => ARM_RELEASE_ID_VISIBLE);
}
