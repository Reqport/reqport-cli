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
  "CLI --json and MCP return that body unchanged.";

/** How the server classified a 2xx response body. Never inferred locally. */
export type ServerDecision = "released" | "held" | "declined" | "unspecified";

/**
 * Server enums this client already speaks. Match is exact (case-sensitive),
 * so NOT_SENT is not SENT and UNRELEASED is not a release.
 *
 * Held wins over decline, and decline wins over release, when a body carries
 * more than one of these tokens.
 */
const HELD_STATES: ReadonlySet<string> = new Set(["HOLD_FOR_APPROVAL", "PENDING_APPROVAL"]);
const DECLINED_STATES: ReadonlySet<string> = new Set(["DECLINE", "DECLINED", "RESPONSE_DECLINED"]);
const RELEASED_STATES: ReadonlySet<string> = new Set(["AUTO_RELEASE", "RESPONDED"]);

function enumToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token === "" ? undefined : token;
}

/**
 * Read the server's own status / approvalState / action. Anything that is not
 * one of the enums above is unspecified — this function does not guess.
 */
export function serverDecision(result: {
  status?: unknown;
  approvalState?: unknown;
  action?: unknown;
}): ServerDecision {
  const tokens = [enumToken(result.status), enumToken(result.approvalState), enumToken(result.action)].filter(
    (token): token is string => token !== undefined
  );
  if (tokens.length === 0) return "unspecified";
  if (tokens.some((token) => HELD_STATES.has(token))) return "held";
  if (tokens.some((token) => DECLINED_STATES.has(token))) return "declined";
  if (tokens.some((token) => RELEASED_STATES.has(token))) return "released";
  return "unspecified";
}
