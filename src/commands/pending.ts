/**
 * `qp pending …` — the human-in-the-loop hold queue for responder answers
 * (server PR #253). When an org's approval policy holds a response type, the
 * submitted answer is parked until an approver releases it; the seal + send then
 * happens server-side.
 *
 *   qp pending list                       (this org's PENDING and REPLACED rows)
 *   qp pending show <id>                  (one row, any status; no release id)
 *   qp pending approve <id>               (release: seal + send, then v3 when a release id is returned)
 *   qp pending reject <id> [--reason …]
 *   qp pending withdraw <id>              (submitter withdraws their own)
 *
 * Approve/reject/withdraw are irreversible state transitions, so they confirm
 * interactively unless --yes (matching `qp respond`).
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { formatReleaseWindow, serverDecision } from "../armSurface.js";
import { performPendingApprove } from "../core.js";
import { confirm, line, printJson, table } from "../ui.js";
import type { PendingActionResult, PendingResponse } from "../types.js";

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
    p.status ?? "",
    p.auth002Status ?? "",
    pendingSubmitter(p),
    typeof p.label === "string" ? p.label : "",
    p.createdAt ?? "",
  ]);
  line(
    table(
      ["PENDING ID", "REQUEST ID", "RESPONSE TYPE", "STATUS", "AUTH.002", "SUBMITTER", "LABEL", "CREATED"],
      rows
    )
  );
  line("");
  line(`${items.length} held response(s). Inspect one:  qp pending show <PENDING ID>`);
  line("Release one:  qp pending approve <PENDING ID>");
  return 0;
}

/** OpenAPI field is `submittedBy`. Older bodies used `submitter`. */
function pendingSubmitter(p: PendingResponse): string {
  if (typeof p.submittedBy === "string" && p.submittedBy.trim()) return p.submittedBy.trim();
  if (typeof p.submitter === "string" && p.submitter.trim()) return p.submitter.trim();
  return "";
}

/**
 * GET /v1/responses/pending/{id}. The row has no release id. Decided rows
 * stay readable after a 409. `--json` is the server body with release ids redacted.
 */
export async function runPendingShow(
  env: ReqportEnv,
  id: string,
  opts: { json?: boolean }
): Promise<number> {
  const client = await clientFor(env);
  const row = await client.getPendingResponse(id);
  if (opts.json) {
    printJson(row);
    return 0;
  }
  line(`Held response ${row.id ?? id}`);
  if (row.requestId) line(`  request:    ${row.requestId}`);
  if (row.responseType) line(`  type:       ${row.responseType}`);
  if (row.status) line(`  status:     ${row.status}`);
  if (row.auth002Status) line(`  auth.002:   ${row.auth002Status}`);
  const submitter = pendingSubmitter(row);
  if (submitter) line(`  submitter:  ${submitter}`);
  if (typeof row.label === "string" && row.label) line(`  label:      ${row.label}`);
  if (typeof row.closedBy === "string" && row.closedBy) line(`  closed by:  ${row.closedBy}`);
  const reason =
    typeof row.decisionReason === "string" && row.decisionReason
      ? row.decisionReason
      : typeof row.reason === "string"
        ? row.reason
        : "";
  if (reason) line(`  reason:     ${reason}`);
  if (row.createdAt) line(`  created:    ${row.createdAt}`);
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
  const res = await performPendingApprove(client, id);
  const formal = res.formal;

  if (opts.json) {
    printJson(res);
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
  if (formal) {
    const window = formatReleaseWindow(res);
    if (window) line(`  expires:    ${window}`);
  }
  return 0;
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
    const reason = res.reason || res.decisionReason;
    if (typeof reason === "string" && reason) line(`  reason: ${reason}`);
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
