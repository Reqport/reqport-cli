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
import { confirm, line, printJson, table } from "../ui.js";
import type { PendingResponse } from "../types.js";

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
  if (!(await confirmAction(opts, `Approve held response ${id}? It will be sealed and sent.`))) {
    return 1;
  }
  const client = await clientFor(env);
  const res = await client.approvePendingResponse(id);

  if (opts.json) {
    printJson(res);
    return 0;
  }
  line(`Approved held response ${res.id ?? id} — sealed and sent server-side.`);
  if (res.status) line(`  status:     ${res.status}`);
  if (res.messageId) line(`  message id: ${res.messageId}`);
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
  line(`Rejected held response ${res.id ?? id}.`);
  if (res.status) line(`  status: ${res.status}`);
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
  line(`Withdrew held response ${res.id ?? id}.`);
  if (res.status) line(`  status: ${res.status}`);
  return 0;
}
