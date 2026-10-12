/**
 * Synthetic vanta#335 decrypt-batch refusal.
 *
 * The code lives on the nested `error` object. The server message is fixed,
 * and the body has no details. A capability mismatch and an unknown payload id
 * share this body. Ids and the key below are fixtures, not live secrets.
 */

export const CONTENT_ACCESS_DENIED_MESSAGE =
  "This content is not available to the caller.";

export const CONTENT_ACCESS_DENIED_BODY = {
  error: {
    code: "CONTENT_ACCESS_DENIED",
    message: CONTENT_ACCESS_DENIED_MESSAGE,
  },
} as const;

/** Human sentence the CLI prints for this code. */
export const CONTENT_ACCESS_HUMAN =
  "You don't have access to this content. If you think you should, contact your administrator.";

export const SYNTHETIC_API_KEY = "rqk_live_syntheticaccessonly";

export const SYNTHETIC_PAYLOAD_IDS = [
  "payload-fixture-a",
  "payload-fixture-b",
  "payload-fixture-c",
] as const;
