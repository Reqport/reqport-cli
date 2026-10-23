/**
 * `qp authority` — staff authority onboarding management.
 *
 *   qp authority propose     — propose a new authority intake
 *   qp authority list-pending — list pending (or filtered) review queue items
 *   qp authority approve <id> — approve a pending review item
 *
 * All three commands call vanta's staff oracle endpoints with the caller's
 * personal JWT (an rqk_live_ key or the stored `qp login` credential).
 * The approve flow is maker-checker: the proposer cannot approve their own item.
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { err, line, printJson, table } from "../ui.js";
import type { AuthorityIntake } from "../types.js";

/** Short date (YYYY-MM-DD) from an ISO timestamp, or "" when absent. */
function shortDate(iso?: string | null): string {
  if (!iso) return "";
  return String(iso).slice(0, 10);
}

/**
 * `qp authority propose` — propose a new authority intake.
 *
 * Calls POST /v1/staff/oracle/authority and prints the returned ReviewItem.
 * The item lands in PENDING state and requires a second staff member to
 * approve (maker-checker).
 */
export async function runAuthorityPropose(
  env: ReqportEnv,
  opts: {
    domain: string;
    name: string;
    country?: string;
    source?: string;
    riskTier?: string;
    json?: boolean;
  }
): Promise<number> {
  if (!opts.domain) throw new Error("--domain <domain> is required.");
  if (!opts.name) throw new Error("--name <name> is required.");
  if (!opts.source) throw new Error("--source <url> is required (a URL evidencing the agency is real, e.g. its official homepage).");

  const intake: AuthorityIntake = {
    domain: opts.domain,
    agencyName: opts.name,
    countryCode: opts.country ?? "EU",
    sourceUrl: opts.source,
    riskTier: (opts.riskTier ?? "STANDARD") as "STANDARD" | "AUTO_APPROVE",
  };

  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  const item = await client.proposeAuthority(intake);

  if (opts.json) {
    printJson(item);
    return 0;
  }

  line(
    table(
      ["ID", "STATUS", "SUMMARY"],
      [[item.id, item.status, item.summary ?? ""]]
    )
  );
  line("");
  line(`Approve with:  qp authority approve ${item.id}`);
  return 0;
}

/**
 * `qp authority list-pending` — list items in the authority review queue.
 *
 * Calls GET /v1/staff/oracle/authority/review (with optional ?status= filter).
 * Defaults to PENDING. Prints a table with id, kind, summary, proposedAt, and
 * a "(you)" marker when proposedByMe is true (meaning the logged-in user cannot
 * approve that row — the maker-checker rule prevents self-approval).
 */
export async function runAuthorityListPending(
  env: ReqportEnv,
  opts: { status?: string; json?: boolean }
): Promise<number> {
  const status = opts.status ?? "PENDING";
  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  const items = await client.listAuthorityReview(status);

  if (opts.json) {
    printJson({ items });
    return 0;
  }

  if (items.length === 0) {
    line(`No items with status ${status} in the authority review queue.`);
    return 0;
  }

  const rows: string[][] = items.map((item) => [
    item.id,
    item.kind ?? "",
    item.summary ?? "",
    shortDate(item.proposedAt),
    item.proposedByMe ? "(you)" : "",
  ]);

  line(table(["ID", "KIND", "SUMMARY", "PROPOSED AT", "BY ME"], rows));
  line("");
  line(
    `${items.length} item(s). Approve (others' proposals only):  qp authority approve <ID>`
  );
  return 0;
}

/**
 * `qp authority approve <id>` — approve a pending authority intake.
 *
 * Calls POST /v1/staff/oracle/authority/review/{id}/approve. The vanta server
 * enforces that the approver must be different from the proposer (maker-checker).
 * Returns the updated ReviewItem with status APPROVED.
 */
export async function runAuthorityApprove(
  env: ReqportEnv,
  id: string,
  opts: { json?: boolean }
): Promise<number> {
  const client = new ReqportClient({ env, credential: await requireResponderCredential() });
  const item = await client.approveAuthorityReview(id);

  if (opts.json) {
    printJson(item);
    return 0;
  }

  line(`Approved: ${item.id}`);
  line(`  status:  ${item.status}`);
  if (item.summary) line(`  summary: ${item.summary}`);
  if (item.decidedAt) line(`  decided: ${item.decidedAt}`);
  line("");
  line(`Authority onboarding approved successfully.`);
  return 0;
}
