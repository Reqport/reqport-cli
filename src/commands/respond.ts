/**
 * `reqport respond <id>` — the full responder loop: read the request (to show
 * the operator what they are answering), build the answer, submit it. Auto-
 * detects the business-relationship endpoint from the workflow type.
 */

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import {
  isBusinessRelationship,
  isTransactionHistory,
  parseAccountArg,
  parseRelationshipTypes,
  performRespond,
  readRequest,
  type RespondInput,
} from "../core.js";
import type { AccountInstrument } from "../types.js";
import { line, printJson } from "../ui.js";

export type RespondCliOptions = {
  hasRelationship?: string; // "true" | "false"
  status?: string; // COMP | NFOU
  note?: string;
  account?: string[];
  relationshipTypes?: string; // comma-separated RelationshipType values

  payloadId?: string;
  freeText?: string;
  statement?: string; // path to a camt.053-CA JSON statement file
  yes?: boolean;
  json?: boolean;
  show?: boolean;
};

export async function runRespond(
  env: ReqportEnv,
  id: string,
  opts: RespondCliOptions
): Promise<number> {
  const client = new ReqportClient({ env, credential: await requireResponderCredential() });

  // Parse inputs up front so bad args fail before any network call.
  let hasRelationship: boolean | undefined;
  if (opts.hasRelationship !== undefined) {
    if (opts.hasRelationship === "true") hasRelationship = true;
    else if (opts.hasRelationship === "false") hasRelationship = false;
    else throw new Error(`--has-relationship must be true or false.`);
  }
  const status =
    opts.status === undefined
      ? undefined
      : opts.status.toUpperCase() === "COMP"
        ? "COMP"
        : opts.status.toUpperCase() === "NFOU"
          ? "NFOU"
          : (() => {
              throw new Error("--status must be COMP or NFOU.");
            })();
  const accounts: AccountInstrument[] | undefined = opts.account?.map(parseAccountArg);
  // Relationship-type tags (business-relationship path). Validate up front; they
  // are only sent on a true answer.
  const relationshipTypes =
    opts.relationshipTypes !== undefined
      ? parseRelationshipTypes(opts.relationshipTypes)
      : undefined;

  // Transaction-history: load the camt.053-CA statement file (parsed here; the
  // server validates it against the schema and seals it in the TEE).
  let statement: unknown;
  if (opts.statement !== undefined) {
    let raw: string;
    try {
      raw = await readFile(opts.statement, "utf-8");
    } catch (e) {
      throw new Error(`Cannot read --statement file "${opts.statement}": ${(e as Error).message}`);
    }
    try {
      statement = JSON.parse(raw);
    } catch (e) {
      throw new Error(`--statement file is not valid JSON (${opts.statement}): ${(e as Error).message}`);
    }
    if (typeof statement !== "object" || statement === null) {
      throw new Error(`--statement file must contain a camt.053-CA JSON object.`);
    }
  }

  const input: RespondInput = {
    hasRelationship,
    status,
    note: opts.note,
    accounts,
    relationshipTypes,
    payloadId: opts.payloadId,
    freeText: opts.freeText,
    statement,
  };

  // Optionally show what is being answered (default on for interactive, off with --json).
  const showFirst = opts.show ?? !opts.json;
  if (showFirst) {
    const detail = await readRequest(client, id);
    const wf = detail.workflow;
    line(`Answering request ${id}`);
    line(`  type:   ${wf.workflowType}`);
    line(`  status: ${wf.status}`);
    if (detail.decoded?.ok) {
      const content =
        detail.decoded.json !== undefined
          ? JSON.stringify(detail.decoded.json)
          : detail.decoded.text;
      line(`  asks:   ${truncate(content ?? "", 400)}`);
    } else if (detail.readNote) {
      line(`  note:   ${detail.readNote}`);
    }
    line("");
    if (isBusinessRelationship(wf.workflowType)) {
      const decision =
        (hasRelationship ?? (status === "COMP")) ? "YES (auth.002 COMP)" : "NO (auth.002 NFOU)";
      line(`  → business-relationship answer: ${decision}`);
      if (accounts?.length) line(`    accounts: ${accounts.map(fmtAccount).join(", ")}`);
      if ((hasRelationship ?? status === "COMP") && relationshipTypes?.length) {
        line(`    relationship types: ${relationshipTypes.join(", ")}`);
      }
    } else if (isTransactionHistory(wf.workflowType)) {
      const s = statement as { profile?: unknown; entries?: unknown } | undefined;
      const profile = typeof s?.profile === "string" ? s.profile : "camt.053-CA";
      const n = Array.isArray(s?.entries) ? s.entries.length : undefined;
      line(`  → transaction-history statement: ${profile}${n !== undefined ? ` (${n} entries)` : ""}`);
    } else {
      line(`  → generic response: ${status ?? (hasRelationship ? "COMP" : "NFOU")}`);
    }
  }

  // Confirmation gate (skipped with --yes or --json/non-interactive).
  if (!opts.yes && !opts.json && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question("Submit this answer? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") {
      line("Aborted.");
      return 1;
    }
  }

  const outcome = await performRespond(client, id, input);

  if (opts.json) {
    printJson(outcome);
    return 0;
  }
  line("");
  line(`Submitted via /v1/requests/{id}/${outcome.endpoint}`);
  line(`  result status: ${outcome.result.status ?? "(ok)"}`);
  if (outcome.result.messageId) line(`  message id:    ${outcome.result.messageId}`);
  line("Verify:  qp requests show " + id);
  return 0;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function fmtAccount(a: AccountInstrument): string {
  return `${a.instrumentType}:${a.identifier}${a.scheme ? `(${a.scheme})` : ""}`;
}
