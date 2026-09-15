/**
 * `qp kyc …` — KYC / CDD (Customer Due Diligence): the responder's answer API.
 * A requester (an authority, or a peer FI carrying a legal basis) asks a bank or
 * exchange for the CDD record it holds on a customer; the responder answers. This
 * is a single request→response family (like the business-relationship check), NOT
 * a multi-message case — so, like `qp respond`, the CLI answers requests; it does
 * NOT create them.
 *
 *   qp kyc list                discover KYC checks addressed to you (affordances)
 *   qp kyc show <requestId>    content-blind read-back of the answer
 *   qp kyc respond <requestId> submit the CDD record (FOUND | NOT_FOUND)
 *
 * CRITICAL: KYC request bodies are **snake_case** (record_status, payload_id, and
 * every nested CddRecord field: natural_person, kyc_status, risk_rating,
 * national_identifier, beneficial_owners, source_of_funds, …) — UNLIKE the FIR
 * commands (camelCase). The record via `--file`/`--json` must be snake_case JSON.
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import {
  kycAffordanceGroups,
  performKycRespond,
  readJsonInput,
  readKycResponse,
  validateKycRecord,
} from "../core.js";
import { confirm, line, printJson, table } from "../ui.js";
import { KYC_RECORD_STATUSES, type CddRecord, type KycRecordStatus } from "../types.js";

async function clientFor(env: ReqportEnv): Promise<ReqportClient> {
  return new ReqportClient({ env, credential: await requireResponderCredential() });
}

/** Shared confirm gate for the mutating action (skipped with --yes/--json/non-TTY). */
async function confirmAction(
  opts: { yes?: boolean; json?: boolean },
  question: string
): Promise<boolean> {
  if (opts.yes || opts.json || !process.stdin.isTTY) return true;
  const ok = await confirm(question);
  if (!ok) line("Aborted.");
  return ok;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

// ── list ──────────────────────────────────────────────────────────────────────

export async function runKycList(
  env: ReqportEnv,
  opts: { state?: string; mine?: boolean; json?: boolean }
): Promise<number> {
  const client = await clientFor(env);
  const res = await client.listAffordances({ state: opts.state ?? "open", mine: opts.mine });
  const groups = kycAffordanceGroups(res);

  if (opts.json) {
    printJson({ total: groups.reduce((n, g) => n + (g.items?.length ?? 0), 0), groups });
    return 0;
  }

  const rows: string[][] = [];
  for (const group of groups) {
    for (const item of group.items ?? []) {
      rows.push(["KYC", item.workflowInstanceId, item.edgeType, item.edgeState, item.createdAt ?? ""]);
    }
  }
  if (rows.length === 0) {
    line(`No ${opts.mine ? "owned" : "addressed"} KYC/CDD checks in state "${opts.state ?? "open"}".`);
    line("(KYC checks surface through /v1/affordances, the same discovery as `qp requests list`.)");
    return 0;
  }
  line(table(["KIND", "REQUEST ID", "TYPE", "STATE", "CREATED"], rows));
  line("");
  line(`${rows.length} KYC/CDD check(s). Answer one:  qp kyc respond <REQUEST ID> --record-status FOUND|NOT_FOUND`);
  return 0;
}

// ── show (content-blind read-back) ─────────────────────────────────────────────

export async function runKycShow(
  env: ReqportEnv,
  requestId: string,
  opts: { json?: boolean }
): Promise<number> {
  const client = await clientFor(env);
  const view = await readKycResponse(client, requestId);

  if (opts.json) {
    printJson(view);
    return 0;
  }
  line(`KYC/CDD request ${view.request_id ?? requestId}`);
  line(`  record status: ${view.record_status ?? "(not yet answered)"}`);
  if (view.workflow_status) line(`  workflow:      ${view.workflow_status}`);
  if (view.requester_org_id) line(`  requester:     ${view.requester_org_id}`);
  if (view.responder_org_id) line(`  responder:     ${view.responder_org_id}  (the answering bank/exchange)`);
  if (view.responded_at) line(`  responded at:  ${view.responded_at}`);
  line("");
  line("Content-blind: the sealed CDD record itself is not decrypted here.");
  if (!view.record_status) {
    line("Next:  qp kyc respond " + requestId + " --record-status FOUND --file <cdd.json>");
  }
  return 0;
}

// ── respond (submit the CDD record) ────────────────────────────────────────────

export type KycRespondOptions = {
  recordStatus?: string;
  file?: string;
  body?: string; // inline CddRecord JSON string (the global --json is machine output)
  payloadId?: string;
  note?: string;
  yes?: boolean;
  jsonOut?: boolean; // the global --json output flag
};

export async function runKycRespond(
  env: ReqportEnv,
  requestId: string,
  opts: KycRespondOptions
): Promise<number> {
  // record_status: mandatory, validated client-side against the enum.
  const raw = opts.recordStatus;
  if (raw === undefined) {
    throw new Error("--record-status is required (FOUND | NOT_FOUND).");
  }
  const recordStatus = raw.toUpperCase();
  if (!(KYC_RECORD_STATUSES as readonly string[]).includes(recordStatus)) {
    throw new Error(`--record-status must be one of ${KYC_RECORD_STATUSES.join(", ")}.`);
  }

  // The record: inline --body string, or a --file path (both snake_case CddRecord
  // JSON), mutually exclusive; OR a pre-sealed --payload-id. (--body, not --json:
  // the global --json is the machine-output flag, consistent with every command.)
  const parsed = await readJsonInput({ file: opts.file, body: opts.body }, "kyc respond");
  const record =
    parsed === undefined ? undefined : (asRecord(parsed, "CDD record") as unknown as CddRecord);

  if (record && opts.payloadId) {
    throw new Error(
      "Provide EITHER an inline record (--file/--body) OR a pre-sealed --payload-id, not both."
    );
  }
  // Spot-validate the record's enums up front (before the banner / network).
  if (record) validateKycRecord(record);

  const jsonOut = Boolean(opts.jsonOut);
  if (!jsonOut) {
    line(`Answering KYC/CDD request ${requestId} (responder → requester):`);
    line(`  record_status: ${recordStatus}${recordStatus === "FOUND" ? " (auth.002 COMP)" : " (auth.002 NFOU)"}`);
    if (opts.payloadId) {
      line(`  record:        pre-sealed payload_id ${opts.payloadId} (content-blind KYC_CDD_JSON)`);
    } else if (record) {
      line(`  record:        inline CDD record (sealed per-party server-side)`);
    } else {
      line(`  record:        (none — a bare ${recordStatus})`);
    }
    line("  (a CDD record carries PII — sealed dual-copy; an approval-gated org must use a pre-sealed payload_id)");
    line("");
  }
  if (!(await confirmAction({ yes: opts.yes, json: jsonOut }, "Submit this KYC/CDD response?"))) {
    return 1;
  }

  const result = await performKycRespond(await clientFor(env), requestId, {
    recordStatus: recordStatus as KycRecordStatus,
    record,
    payloadId: opts.payloadId,
    note: opts.note,
  });

  if (jsonOut) {
    printJson(result);
    return 0;
  }
  const status = result.status ?? "(ok)";
  line(`Submitted KYC/CDD response — status: ${status}`);
  if (status === "PENDING_APPROVAL") {
    line("  Held for human approval by your org's policy — release it with `qp pending approve <id>`.");
    line("  (an inline record is rejected when gated — resubmit with a pre-sealed --payload-id)");
  }
  if (result.messageId) line(`  message id: ${result.messageId}`);
  line("Verify:  qp kyc show " + requestId);
  return 0;
}
