/**
 * `qp pending …` — the human-in-the-loop hold queue for responder answers
 * (server PR #253). When an org's approval policy holds a response type, the
 * submitted answer is parked until an approver releases it; the seal + send then
 * happens server-side.
 *
 *   qp pending list                       (this org's held responses)
 *   qp pending approve <id>               (release: seal + send)
 *   qp pending reject <id> [--reason …]
 *   qp pending withdraw <id>              (submitter withdraws their own)
 *
 * Approve/reject/withdraw are irreversible state transitions, so they confirm
 * interactively unless --yes (matching `qp respond`).
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { displayReleaseId, releasedArmReleaseId, serverDecision } from "../armSurface.js";
import { forwardArmRelease } from "../core.js";
import { confirm, line, printJson, table } from "../ui.js";
import type { FormalRespondResult, PendingActionResult, PendingResponse } from "../types.js";

async function clientFor(env: ReqportEnv): Promise<ReqportClient> {
  return new ReqportClient({ env, credential: await requireResponderCredential() });
}

/** Normalise the list endpoint's two possible shapes (array or {items}). */
function pendingItems(raw: PendingResponse[] | { items?: PendingResponse[] }): PendingResponse[] {
  if (Array.isArray(raw)) return raw;
  return raw.items ?? [];
}

export async function runPendingList(
  env: ReqportEnv,
  opts: { json?: boolean }
): Promise<number> {
  const client = await clientFor(env);
  const raw = await client.listPendingResponses();

  if (opts.json) {
    printJson(raw);
    return 0;
  }

  const items = pendingItems(raw);
  if (items.length === 0) {
    line("No held responses awaiting approval.");
    return 0;
  }
  const rows = items.map((p) => [
    p.id,
    p.requestId ?? "",
    p.responseType ?? "",
    p.auth002Status ?? "",
    p.submitter ?? "",
    p.createdAt ?? "",
  ]);
  line(
    table(
      ["PENDING ID", "REQUEST ID", "RESPONSE TYPE", "AUTH.002", "SUBMITTER", "CREATED"],
      rows
    )
  );
  line("");
  line(`${items.length} held response(s). Release one:  qp pending approve <PENDING ID>`);
  return 0;
}

/** Shared confirm gate for the irreversible actions (skipped with --yes/--json/non-TTY). */
async function confirmAction(
  opts: { yes?: boolean; json?: boolean },
  question: string
): Promise<boolean> {
  if (opts.yes || opts.json || !process.stdin.isTTY) return true;
  const ok = await confirm(question);
  if (!ok) line("Aborted.");
  return ok;
}

export async function runPendingApprove(
  env: ReqportEnv,
  id: string,
  opts: { yes?: boolean; json?: boolean }
): Promise<number> {
  if (!(await confirmAction(opts, `Approve held response ${id}? The server seals and sends it when it accepts this approval.`))) {
    return 1;
  }
  const client = await clientFor(env);
  const res = await client.approvePendingResponse(id);
  const formal = await forwardHumanRelease(client, id, res);

  if (opts.json) {
    printJson(formal ? { ...res, formal } : res);
    return 0;
  }
  // Formal delivery status stands alone. Do not mix it with the gate's
  // AUTO_RELEASE / RELEASED tokens, or a non-release formal status would
  // still be described as sealed and sent.
  renderPendingDecision(
    "approve",
    id,
    formal
      ? {
          id: res.id ?? id,
          status: formal.status,
          messageId: res.messageId,
          requestId: res.requestId,
        }
      : res
  );
  return 0;
}

/**
 * Human RELEASED approve: capture releaseId and post the v3 formal respond
 * with the header. No releaseId means the server finished inline (no header).
 * A releaseId without a request id cannot be forwarded, and is not described
 * as sealed and sent.
 */
async function forwardHumanRelease(
  client: ReqportClient,
  pendingId: string,
  res: PendingActionResult
): Promise<FormalRespondResult | undefined> {
  const releaseId = releasedArmReleaseId(res);
  if (!releaseId) return undefined;
  const requestId = typeof res.requestId === "string" ? res.requestId.trim() : "";
  if (!requestId) {
    throw new Error(
      `Server released pending response ${pendingId} but the approve body had no requestId (release ${displayReleaseId(releaseId)}). The formal respond was not sent.`
    );
  }
  return forwardArmRelease(client, requestId, res);
}

export async function runPendingReject(
  env: ReqportEnv,
  id: string,
  opts: { reason?: string; yes?: boolean; json?: boolean }
): Promise<number> {
  if (!(await confirmAction(opts, `Reject held response ${id}?`))) return 1;
  const client = await clientFor(env);
  const res = await client.rejectPendingResponse(id, opts.reason);

  if (opts.json) {
    printJson(res);
    return 0;
  }
  renderPendingDecision("reject", id, res);
  return 0;
}

export async function runPendingWithdraw(
  env: ReqportEnv,
  id: string,
  opts: { yes?: boolean; json?: boolean }
): Promise<number> {
  if (!(await confirmAction(opts, `Withdraw held response ${id}?`))) return 1;
  const client = await clientFor(env);
  const res = await client.withdrawPendingResponse(id);

  if (opts.json) {
    printJson(res);
    return 0;
  }
  renderPendingDecision("withdraw", id, res);
  return 0;
}

/**
 * Print only what the server decided. A HOLD or decline is not framed as
 * sealed-and-sent; that wording is reserved for a server release.
 */
function renderPendingDecision(
  action: "approve" | "reject" | "withdraw",
  id: string,
  res: PendingActionResult
): void {
  const decision = serverDecision(res);
  const shownId = res.id ?? id;
  if (decision === "held") {
    line(`Server left response ${shownId} awaiting approval${res.status ? ` (${res.status})` : ""}.`);
    if (typeof res.approvalState === "string" && res.approvalState) {
      line(`  approval: ${res.approvalState}`);
    }
    return;
  }
  if (decision === "declined") {
    line(`Server declined response ${shownId}${res.status ? ` (${res.status})` : ""}.`);
    if (typeof res.reason === "string" && res.reason) line(`  reason: ${res.reason}`);
    return;
  }
  if (action === "approve" && decision === "released") {
    line(`Approved held response ${shownId} — sealed and sent server-side.`);
    if (res.status) line(`  status:     ${res.status}`);
    if (res.messageId) line(`  message id: ${res.messageId}`);
    return;
  }
  if (action === "approve") {
    // unspecified / empty / unknown: the raw status only. No release claim.
    line(`Server response for ${shownId}: ${rawStatus(res)}`);
    if (typeof res.approvalState === "string" && res.approvalState) {
      line(`  approval: ${res.approvalState}`);
    }
    if (res.messageId) line(`  message id: ${res.messageId}`);
    return;
  }
  if (action === "reject") {
    line(`Rejected held response ${shownId}.`);
  } else if (action === "withdraw") {
    line(`Withdrew held response ${shownId}.`);
  } else {
    line(`Server response for ${shownId}: ${rawStatus(res)}`);
  }
  if (res.status) line(`  status:     ${res.status}`);
  if (res.messageId) line(`  message id: ${res.messageId}`);
}

function rawStatus(res: PendingActionResult): string {
  if (typeof res.status !== "string" || res.status.trim() === "") return "(no status)";
  return res.status;
}
