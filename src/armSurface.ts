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
 * Read the server's own status / approvalState / action. HOLD and decline win
 * over any release word so a mixed body cannot be framed as sent.
 */
export function serverDecision(result: {
  status?: unknown;
  approvalState?: unknown;
  action?: unknown;
}): ServerDecision {
  const status = typeof result.status === "string" ? result.status : "";
  const approval = typeof result.approvalState === "string" ? result.approvalState : "";
  const action = typeof result.action === "string" ? result.action : "";
  const blob = `${status} ${approval} ${action}`.toUpperCase();
  if (blob.trim() === "") return "unspecified";
  if (/(DECLIN|REJECT)/.test(blob)) return "declined";
  if (/(HOLD|PENDING)/.test(blob)) return "held";
  if (/(AUTO_RELEASE|RELEASED|APPROVED|SENT|SEALED|RESPONDED)/.test(blob)) return "released";
  return "unspecified";
}
