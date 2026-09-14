/**
 * `qp fir …` — Fraud Incident Response (FIR): a multi-message FI-to-FI fraud
 * case between a sending bank and a receiving institution (a client-funds holder
 * such as Goobit). The case flows through four P0 messages over one workflow
 * instance whose id is the fir_id:
 *
 *   NOTICE  (bank → receiver)   qp fir notify          create the case
 *   RESPONSE (receiver → bank)  qp fir respond         one outcome per transaction
 *   REFUND_INSTRUCTION (bank →) qp fir instruct-refund authorise a refund
 *   REFUND_CONFIRMATION (recv→) qp fir confirm-refund  confirm it executed
 *
 * Roles: the SENDING BANK opens the case (notify) and instructs refunds; the
 * RECEIVER answers (respond) and confirms refunds. A receiver discovers incoming
 * cases with `qp fir list` (the same /v1/affordances discovery `qp requests list`
 * uses — there is no list-cases endpoint) and reads one with `qp fir show`.
 *
 * Bodies carry the two institutions (sender/recipient) plus a payload. The
 * institutions are self-declared identity objects, so every write command takes
 * them from a `--file`/`--body` JSON (or inline `--sender`/`--recipient`), while
 * the payload can be built with convenience flags. money amounts are STRINGS.
 * The mutating commands confirm interactively unless `-y`/`--yes` (or `--json`).
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import {
  firAffordanceGroups,
  parseFirOutcomeArg,
  performFirConfirmRefund,
  performFirInstructRefund,
  performFirNotify,
  performFirRespond,
  readFirCase,
  readJsonInput,
} from "../core.js";
import { confirm, line, printJson, table } from "../ui.js";
import type {
  FirConfirmRefundRequest,
  FirCreateNoticeRequest,
  FirInstitution,
  FirRefundInstruction,
  FirRefundInstructionRequest,
  FirResponseOutcome,
  FirSubmitResponseRequest,
} from "../types.js";

async function clientFor(env: ReqportEnv): Promise<ReqportClient> {
  return new ReqportClient({ env, credential: await requireResponderCredential() });
}

/** Shared confirm gate for the mutating actions (skipped with --yes/--json/non-TTY). */
async function confirmAction(
  opts: { yes?: boolean; json?: boolean },
  question: string
): Promise<boolean> {
  if (opts.yes || opts.json || !process.stdin.isTTY) return true;
  const ok = await confirm(question);
  if (!ok) line("Aborted.");
  return ok;
}

/** Parse an inline JSON flag (e.g. --sender '{...}') into an object, or undefined. */
function parseInlineJson<T>(raw: string | undefined, label: string): T | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`--${label}: not valid JSON: ${(e as Error).message}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

// ── list ──────────────────────────────────────────────────────────────────────

export async function runFirList(
  env: ReqportEnv,
  opts: { state?: string; mine?: boolean; json?: boolean }
): Promise<number> {
  const client = await clientFor(env);
  const res = await client.listAffordances({ state: opts.state ?? "open", mine: opts.mine });
  const groups = firAffordanceGroups(res);

  if (opts.json) {
    printJson({ total: groups.reduce((n, g) => n + (g.items?.length ?? 0), 0), groups });
    return 0;
  }

  const rows: string[][] = [];
  for (const group of groups) {
    for (const item of group.items ?? []) {
      rows.push(["FIR", item.workflowInstanceId, item.edgeType, item.edgeState, item.createdAt ?? ""]);
    }
  }
  if (rows.length === 0) {
    line(
      `No ${opts.mine ? "owned" : "addressed"} FIR cases in state "${opts.state ?? "open"}".`
    );
    line("(FIR cases surface through /v1/affordances, the same discovery as `qp requests list`.)");
    return 0;
  }
  line(table(["KIND", "FIR ID", "TYPE", "STATE", "CREATED"], rows));
  line("");
  line(`${rows.length} FIR case(s). Read one:  qp fir show <FIR ID>`);
  return 0;
}

// ── show ────────────────────────────────────────────────────────────────────

export async function runFirShow(
  env: ReqportEnv,
  firId: string,
  opts: { json?: boolean }
): Promise<number> {
  const client = await clientFor(env);
  const view = await readFirCase(client, firId);

  if (opts.json) {
    printJson(view);
    return 0;
  }
  line(`FIR case ${view.firId}`);
  if (view.workflowType) line(`  type:      ${view.workflowType}`);
  line(`  status:    ${view.status ?? "(unknown)"}${view.responseOutcome ? ` (${view.responseOutcome})` : ""}`);
  if (view.requesterOrgId) line(`  requester: ${view.requesterOrgId}  (the sending bank)`);
  if (view.responderOrgId) line(`  responder: ${view.responderOrgId}  (the receiver)`);
  if (view.createdAt) line(`  created:   ${view.createdAt}`);
  if (view.updatedAt) line(`  updated:   ${view.updatedAt}`);
  line("");
  line("Content-blind: sealed message payloads are not decrypted here.");
  line("Next:  qp fir respond " + firId + " --outcome <ref>:HELD --sender <json> --recipient <json>");
  return 0;
}

// ── notify (create NOTICE) ────────────────────────────────────────────────────

export type FirNotifyOptions = {
  file?: string;
  body?: string;
  yes?: boolean;
  json?: boolean;
};

export async function runFirNotify(env: ReqportEnv, opts: FirNotifyOptions): Promise<number> {
  const parsed = await readJsonInput({ file: opts.file, body: opts.body }, "notify");
  if (parsed === undefined) {
    throw new Error("Provide the NOTICE body with --file <notice.json> or --body <inline JSON>.");
  }
  const body = asRecord(parsed, "notify body") as unknown as FirCreateNoticeRequest;

  const txnCount = Array.isArray(body.notice?.transactions) ? body.notice.transactions.length : 0;
  if (!opts.json) {
    line("Opening a FIR case (NOTICE, sending bank → receiver):");
    line(`  recipient org: ${body.recipientOrgId ?? "(missing)"}`);
    line(`  transactions:  ${txnCount}`);
    if (body.notice?.requestedAction) line(`  requested:     ${body.notice.requestedAction}`);
    line("");
  }
  if (!(await confirmAction(opts, "Send this NOTICE and open the case?"))) return 1;

  const result = await performFirNotify(await clientFor(env), body);
  if (opts.json) {
    printJson(result);
    return 0;
  }
  line(`FIR case opened: ${result.firId}${result.status ? ` (${result.status})` : ""}`);
  line("Track it:  qp fir show " + result.firId);
  return 0;
}

// ── respond (RESPONSE) ────────────────────────────────────────────────────────

export type FirRespondOptions = {
  file?: string;
  body?: string;
  sender?: string;
  recipient?: string;
  outcome?: string[];
  note?: string;
  yes?: boolean;
  json?: boolean;
};

/**
 * Resolve sender/recipient from an optional base body then inline overrides.
 * Every FIR write body carries both institutions; they can live in the --file
 * base body or be supplied/overridden inline with --sender / --recipient.
 */
function resolveParties(
  base: Record<string, unknown>,
  senderFlag?: string,
  recipientFlag?: string
): { sender?: FirInstitution; recipient?: FirInstitution } {
  const sender =
    parseInlineJson<FirInstitution>(senderFlag, "sender") ??
    (base.sender as FirInstitution | undefined);
  const recipient =
    parseInlineJson<FirInstitution>(recipientFlag, "recipient") ??
    (base.recipient as FirInstitution | undefined);
  return { sender, recipient };
}

export async function runFirRespond(
  env: ReqportEnv,
  firId: string,
  opts: FirRespondOptions
): Promise<number> {
  const parsed = (await readJsonInput({ file: opts.file, body: opts.body }, "respond")) ?? {};
  const base = asRecord(parsed, "respond body");
  const { sender, recipient } = resolveParties(base, opts.sender, opts.recipient);

  // Outcomes: flags replace; otherwise fall back to the base body's outcomes.
  let outcomes: FirResponseOutcome[];
  if (opts.outcome && opts.outcome.length > 0) {
    outcomes = opts.outcome.map(parseFirOutcomeArg);
  } else if (Array.isArray(base.outcomes)) {
    outcomes = base.outcomes as FirResponseOutcome[];
  } else {
    throw new Error(
      "Provide at least one --outcome <ref>:<HELD|PROCESSED|PARTIAL|NEED_INFO>[:<heldAmount>:<currency>], or a --file/--body with an outcomes array."
    );
  }
  const note = opts.note ?? (typeof base.note === "string" ? base.note : undefined);

  const body: FirSubmitResponseRequest = {
    sender: sender as FirInstitution,
    recipient: recipient as FirInstitution,
    outcomes,
    ...(note ? { note } : {}),
  };

  if (!opts.json) {
    line(`Answering FIR case ${firId} (RESPONSE, receiver → bank):`);
    for (const o of outcomes) {
      line(
        `  ${o.transactionRef}: ${o.outcome}${o.heldAmount ? ` (held ${o.heldAmount.amount} ${o.heldAmount.currency})` : ""}`
      );
    }
    line("");
  }
  if (!(await confirmAction(opts, "Submit this RESPONSE?"))) return 1;

  const result = await performFirRespond(await clientFor(env), firId, body);
  if (opts.json) {
    printJson(result);
    return 0;
  }
  line(`Submitted RESPONSE — status: ${result.status ?? "(ok)"}`);
  if (result.messageId) line(`  message id: ${result.messageId}`);
  line("Verify:  qp fir show " + firId);
  return 0;
}

// ── instruct-refund (REFUND_INSTRUCTION) ──────────────────────────────────────

export type FirInstructRefundOptions = {
  file?: string;
  body?: string;
  sender?: string;
  recipient?: string;
  transactionRef?: string;
  returnTo?: string; // inline Account JSON
  returnIban?: string;
  returnAccountType?: string;
  returnLabel?: string;
  referenceText?: string;
  verificationType?: string;
  verificationDescription?: string;
  confirmationRequested?: boolean;
  yes?: boolean;
  json?: boolean;
};

export async function runFirInstructRefund(
  env: ReqportEnv,
  firId: string,
  opts: FirInstructRefundOptions
): Promise<number> {
  const parsed = (await readJsonInput({ file: opts.file, body: opts.body }, "instruct-refund")) ?? {};
  const base = asRecord(parsed, "instruct-refund body");
  const { sender, recipient } = resolveParties(base, opts.sender, opts.recipient);

  // The base refund-instruction may come from the body (as `refundInstruction`)
  // or be built from flags; flags override individual fields.
  const baseRi = (base.refundInstruction as Partial<FirRefundInstruction> | undefined) ?? {};

  // return_to: inline JSON wins, else granular flags, else the base body.
  let returnTo = parseInlineJson<FirRefundInstruction["returnTo"]>(opts.returnTo, "return-to");
  if (!returnTo && (opts.returnIban || opts.returnAccountType || opts.returnLabel)) {
    returnTo = {
      ...(opts.returnAccountType ? { accountType: opts.returnAccountType } : {}),
      ...(opts.returnIban ? { iban: opts.returnIban } : {}),
      ...(opts.returnLabel ? { label: opts.returnLabel } : {}),
    };
  }
  returnTo = returnTo ?? baseRi.returnTo;

  const verification =
    opts.verificationType || opts.verificationDescription
      ? {
          ...(opts.verificationType ? { challengeType: opts.verificationType } : {}),
          ...(opts.verificationDescription ? { description: opts.verificationDescription } : {}),
        }
      : baseRi.verification;

  const transactionRef = opts.transactionRef ?? baseRi.transactionRef;
  const returnReferenceText = opts.referenceText ?? baseRi.returnReferenceText;
  const confirmationRequested =
    opts.confirmationRequested !== undefined ? opts.confirmationRequested : baseRi.confirmationRequested;

  const refundInstruction: FirRefundInstruction = {
    transactionRef: transactionRef as string,
    returnTo: returnTo as FirRefundInstruction["returnTo"],
    ...(returnReferenceText ? { returnReferenceText } : {}),
    ...(verification ? { verification } : {}),
    ...(confirmationRequested !== undefined ? { confirmationRequested } : {}),
  };

  const body: FirRefundInstructionRequest = {
    sender: sender as FirInstitution,
    recipient: recipient as FirInstitution,
    refundInstruction,
  };

  if (!opts.json) {
    line(`Instructing a refund on FIR case ${firId} (bank → receiver):`);
    line(`  transaction: ${refundInstruction.transactionRef ?? "(missing)"}`);
    if (returnTo?.iban || returnTo?.accountNumber) {
      line(`  return to:   ${returnTo.iban ?? returnTo.accountNumber}${returnTo.label ? ` (${returnTo.label})` : ""}`);
    }
    line("");
  }
  if (!(await confirmAction(opts, "Send this REFUND_INSTRUCTION?"))) return 1;

  const result = await performFirInstructRefund(await clientFor(env), firId, body);
  if (opts.json) {
    printJson(result);
    return 0;
  }
  line(`Refund instructed on FIR case ${firId} — sealed dual-copy to both parties.`);
  line("Verify:  qp fir show " + firId);
  return 0;
}

// ── confirm-refund (REFUND_CONFIRMATION) ──────────────────────────────────────

export type FirConfirmRefundOptions = {
  file?: string;
  body?: string;
  sender?: string;
  recipient?: string;
  payloadId?: string;
  note?: string;
  yes?: boolean;
  json?: boolean;
};

export async function runFirConfirmRefund(
  env: ReqportEnv,
  firId: string,
  opts: FirConfirmRefundOptions
): Promise<number> {
  const parsed = (await readJsonInput({ file: opts.file, body: opts.body }, "confirm-refund")) ?? {};
  const base = asRecord(parsed, "confirm-refund body");
  const { sender, recipient } = resolveParties(base, opts.sender, opts.recipient);

  const payloadId = opts.payloadId ?? (typeof base.payloadId === "string" ? base.payloadId : undefined);
  const note = opts.note ?? (typeof base.note === "string" ? base.note : undefined);

  const body: FirConfirmRefundRequest = {
    sender: sender as FirInstitution,
    recipient: recipient as FirInstitution,
    payloadId: payloadId as string,
    ...(note ? { note } : {}),
  };

  if (!opts.json) {
    line(`Confirming a refund executed on FIR case ${firId} (receiver → bank):`);
    line(`  RefundExecution payloadId: ${payloadId ?? "(missing)"}`);
    line("  (carries a pre-sealed payload; your org's approval policy may hold it for review)");
    line("");
  }
  if (!(await confirmAction(opts, "Send this REFUND_CONFIRMATION?"))) return 1;

  const result = await performFirConfirmRefund(await clientFor(env), firId, body);
  if (opts.json) {
    printJson(result);
    return 0;
  }
  const status = result.status ?? "(ok)";
  line(`Submitted REFUND_CONFIRMATION — status: ${status}`);
  if (status === "PENDING_APPROVAL") {
    line("  Held for human approval by your org's policy — release it with `qp pending approve <id>`.");
  }
  if (result.messageId) line(`  message id: ${result.messageId}`);
  line("Verify:  qp fir show " + firId);
  return 0;
}
