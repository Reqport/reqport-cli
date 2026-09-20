/**
 * `qp arm` — print the ARM (Authority Request Management) flow: the full
 * authority↔company exchange (BR check + targeted follow-ups) and where the
 * human-in-the-loop / auto-release decisions live. Static docs, no credential.
 */

import { line } from "../ui.js";

const ARM_TEXT = `ARM — Authority Request Management

The full authority <-> company exchange: a business-relationship (BR) check, and —
if there is a relationship — targeted follow-ups (transaction history per disclosed
instrument, or a KYC/CDD file) on the SAME case. Whether each answer auto-releases
or waits for a human is decided by YOUR org's rules, not hard-coded.

SETUP (responder, once)
  qp org-states <authorityOrgId>          inspect a requestor's verified status
  qp requestor-ruleset add|set|get|clear  auto-release / hold / decline by status
  qp approval-policy get|set <types|ALL>   per-type: which answers need approval
    Rules are evaluated in order, first match wins; no match falls back to the
    per-type approval policy. Example ruleset:
      1. IF authority=true, country=SE        -> AUTO_RELEASE
      2. IF {} (any requestor, catch-all)     -> HOLD_FOR_APPROVAL

1. BR CHECK
   Authority -> POST /v1/requests/business-relationship-check
   You       -> read (qp requests show), answer (qp respond --has-relationship ...)
                YES discloses accounts (+ optional relationship types).
   Vanta evaluates your ruleset on the requestor's oracle-verified status.
   Typical: a verified authority auto-releases; the authority reads the accounts.

2. TARGETED FOLLOW-UPS (same case, linked via relatesTo)
   Authority -> POST /v1/requests/{brId}/transaction-history-followup (instrument + timespan)
   Authority -> POST /v1/requests/{brId}/kyc-followup
   Authority -> POST /v1/requests/{brId}/information-followup (free-text ask)
   You       -> answer; the SAME gate applies.
   Typical: follow-ups are HELD for a human.
   A BR "true" (with or without the optional accounts) may still not be enough:
   the free-text INFORMATION follow-up asks for more in plain language, answered
   on the generic response path (qp respond --status COMP --free-text "...").

ALTERNATE ENTRY — you ALREADY hold the identifier (start later in the flow)
   When the authority already has a wallet/account (from another investigation,
   a tip, a seized device), there is nothing to discover: skip the BR check and
   ask a KNOWN holder directly. First-class request, no relatesTo.
     qp requests create tx-history --responder <domain> --wallet <addr> \\
         --from 2025-01-01 --to 2026-01-01 --case INV-9 --legal-basis "RB 27:1"
     qp requests create kyc --responder <domain> --personnummer <pnr> \\
         --case INV-9 --legal-basis "RB 27:1"
     qp requests create information --responder <domain> --request "..." \\
         --case INV-9 --legal-basis "RB 27:1"
   (API: POST /v1/requests/transaction-history | /v1/requests/kyc | /v1/requests/information.)
   The responder answers it exactly as a follow-up, and the SAME ruleset/approval gate applies.
   Unknown holder (which company holds this wallet?) is holder-discovery — separate.

HUMAN-IN-THE-LOOP
  qp pending list                 see held answers awaiting approval
  qp pending approve <id>         release (sealed + sent on approval)
  qp pending reject <id>          decline (the authority sees the decline + reason)
  Nothing reaches the authority until it is released.

The rendered sequence diagram is in the developer docs (/developer) and in the
reqport-responder skill (SKILL.md).`;

export async function runArm(): Promise<number> {
  line(ARM_TEXT);
  return 0;
}
