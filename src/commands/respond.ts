/**
 * `reqport respond <id>` — the full responder loop: read the request (to show
 * the operator what they are answering), build the answer, submit it. Auto-
 * detects the business-relationship endpoint from the workflow type.
 */

import { createInterface } from "node:readline/promises";
import { ReqportClient } from "../client.js";
import { requireApiKey, type ReqportEnv } from "../env.js";
import {
  isBusinessRelationship,
  parseAccountArg,
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
  payloadId?: string;
  freeText?: string;
  yes?: boolean;
  json?: boolean;
  show?: boolean;
};

export async function runRespond(
  env: ReqportEnv,
  id: string,
  opts: RespondCliOptions
): Promise<number> {
  const client = new ReqportClient({ env, apiKey: requireApiKey() });

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

  const input: RespondInput = {
    hasRelationship,
    status,
    note: opts.note,
    accounts,
    payloadId: opts.payloadId,
    freeText: opts.freeText,
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
  line("Verify:  reqport requests show " + id);
  return 0;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function fmtAccount(a: AccountInstrument): string {
  return `${a.instrumentType}:${a.identifier}${a.scheme ? `(${a.scheme})` : ""}`;
}
