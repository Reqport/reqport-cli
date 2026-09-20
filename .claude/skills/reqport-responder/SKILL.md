---
name: reqport-responder
description: >
  Build and verify a Reqport responder integration end-to-end against the
  sandbox. Use when the task is to answer Reqport data requests — especially
  business-relationship (BR) checks (ISO 20022 auth.002) — as a data-holder
  company, using the `qp` CLI (@reqport/cli) and/or its bundled MCP server.
  Triggers: "answer a Reqport request", "business relationship check", "BR
  check", "ARM", "reqport responder", "rqk_live key", "qp cli".
---

# Reqport responder integration

You are integrating a data-holder **company** as a **responder** on Reqport: an
authority sends the company a request ("do you hold this person/organisation as a
customer?"), and the company answers **yes/no (+ optional account numbers)** as an
ISO 20022 **auth.002** response. This skill drives that loop with the `qp` CLI
(package `@reqport/cli`; `npx @reqport/cli` installs the `qp` binary).

## What you must know first (the security model)

Reqport is **content-blind**: request/answer payloads are encrypted and the
server stores only ciphertext. **But the responder loop is server-assisted** —
you do **not** implement any client-side cryptography:

- **Reading** a request calls `POST /v1/payloads/decrypt-batch`; the Trusted
  Execution Environment (TEE) decrypts inside the enclave and returns plaintext
  to your authorized credential. The CLI does this for you.
- **Answering** a business-relationship check sends a tiny JSON body
  (`hasRelationship` + optional typed accounts); the TEE **seals it server-side**.

So the CLI is a thin HTTP client + your credential. **No dual-JWE, device keys, or
DPoP.** The only path that needs client-side encryption is uploading a *sealed
answer document* for the generic `/response` structured path — out of scope for
the business-relationship loop; do not attempt it here.

## Auth and environment

- **Automation (what you should use): an `rqk_live_` API key** in
  **`REQPORT_API_KEY`**. Never hardcode it, never print it, never commit it. The
  CLI never accepts a key as a flag.
- If you have **no** key: ask the human to get one onto the machine — either by
  running `qp login --env sandbox` (a browser pairing with the console: they
  approve, and the key is stored as the CLI's credential), or by creating one in
  the console `/developer` page and exporting it as `REQPORT_API_KEY`. Key
  management (create/list/revoke) is console-only — an API key cannot mint keys,
  and you cannot complete an interactive console pairing yourself.
- Target env with `--env sandbox|uat|prod` (default `sandbox`). **Use `sandbox`.**
  Never touch `prod`.

## Setup

```bash
export REQPORT_API_KEY="rqk_live_..."     # PowerShell: $env:REQPORT_API_KEY="rqk_live_..."
npx @reqport/cli --env sandbox doctor     # or: qp --env sandbox doctor
```

`doctor` verifies the base URL, TEE attestation, and that your credential
authenticates. Expect it to report open requests addressed to you once seeding
has run.

> Sandbox is seeded by a synthetic authority (`reqport-authority-test.com`) that
> sends onboarded sandbox companies business-relationship-check requests. If
> `doctor` / `requests list` show zero, seeding may not have reached your org yet
> — say so and continue against the documented contract rather than inventing data.

## ARM — the full flow (Authority Request Management)

ARM is the whole authority↔company exchange: a **BR check** ("do you hold this
subject as a customer?"), and — if there is a relationship — **targeted follow-ups**
(a transaction-history request per disclosed instrument, or a KYC/CDD file) on the
**same case**. Whether each answer auto-releases or waits for a human is decided by
**your org's rules**, not hard-coded.

```mermaid
sequenceDiagram
    autonumber
    actor AU as Authority (requester)
    participant V as Reqport / Vanta (TEE)
    participant CO as Company (responder — you)
    actor OP as Your approver (human)

    Note over CO,V: SETUP (once) — you configure your trust rules
    CO->>V: GET /v1/orgs/{authorityId}/states   (reference:read)
    V-->>CO: {isAuthority, lawEnforcement, regulatoryClasses, country, ...}
    CO->>V: PUT /v1/responses/requestor-ruleset   (ordered; first match wins)
    Note right of V: e.g. {authority:true, country:SE} → AUTO_RELEASE<br/>{} (catch-all) → HOLD_FOR_APPROVAL
    CO->>V: PUT /v1/responses/approval-policy   (per-type: which need approval)

    Note over AU,V: 1. BR check
    AU->>V: POST /v1/requests/business-relationship-check   (authority:write)
    V->>CO: notify (request sealed to you)
    CO->>V: read (decrypt-batch) → answer YES + accounts + relationshipTypes
    Note right of V: evaluate ruleset (oracle-verified requestor status)<br/>verified authority → AUTO_RELEASE
    V-->>AU: RESPONDED (approvalState = null → automatic)
    AU->>V: read the disclosed accounts

    opt ALT ENTRY — authority already holds the identifier (start here, no BR check)
        AU->>V: POST /v1/requests/transaction-history (responder + wallet + timespan)
        Note right of V: first-class request, no relatesTo;<br/>same sealing + same ruleset/approval gate
        V->>CO: notify → you answer exactly as a follow-up
    end

    Note over AU,V: 2. Targeted follow-ups on the SAME case (relatesTo)
    AU->>V: POST /v1/requests/{brId}/transaction-history-followup (instrument + timespan)
    AU->>V: POST /v1/requests/{brId}/kyc-followup
    V->>CO: notify (follow-ups, same thread)
    CO->>V: transaction-history / KYC response
    alt HOLD_FOR_APPROVAL (typical for follow-ups)
        V-->>CO: 202 PENDING_APPROVAL (nothing sent yet)
        Note over AU: authority sees approvalState = PENDING_APPROVAL
        OP->>V: POST /v1/responses/pending/{id}/approve → sealed + sent
    else AUTO_RELEASE
        Note right of V: sealed + sent immediately
    else DECLINE
        V-->>AU: RESPONSE_DECLINED (+ reason)
    end
    V-->>AU: follow-up RESPONDED (or DECLINED + reason)
```

Key points:

- The **same approval gate** applies to every answer (BR + follow-ups): your
  **requestor-status ruleset** (`qp requestor-ruleset`) is evaluated first — first
  matching rule wins — then falls back to the **per-type approval policy**
  (`qp approval-policy`). "BR auto, follow-ups need a human" is the *typical
  configuration*, not a built-in rule.
- **Requestor status is oracle-verified and matched server-side** at answer time;
  you fetch `/states` (`qp org-states <orgId>`) once, to *author* the rules.
- Follow-ups **link back via `relatesTo`** and share the case — data-minimised (one
  transaction-history request per disclosed instrument).
- **Identifier-first entry:** when the authority *already* holds the identifier (a
  wallet from another investigation), it skips the BR check and asks a known holder
  directly (`POST /v1/requests/transaction-history` | `/kyc`, no `relatesTo`). You
  answer it identically, and the **same gate** applies. (Finding *which* company
  holds an unknown wallet is holder-discovery — a separate capability.)
- Nothing reaches the authority until it is **released** (auto or human-approved);
  a decline returns to the authority with a reason.

## The loop

1. **Discover** open requests addressed to you:
   ```bash
   qp --env sandbox requests list
   ```
   Output is structure only (request id, type, state) — no content. Business
   relationship checks have a type containing `BUSINESS_RELATIONSHIP`.

2. **Read** one request (decrypts the request payload in the TEE):
   ```bash
   qp --env sandbox requests show <REQUEST_ID>
   ```

3. **Answer** it (the CLI auto-detects the business-relationship endpoint):
   ```bash
   # No such customer → auth.002 NFOU
   qp --env sandbox respond <REQUEST_ID> --has-relationship false --yes

   # Yes, with disclosed accounts → auth.002 COMP (accounts sealed in the TEE)
   qp --env sandbox respond <REQUEST_ID> \
     --has-relationship true \
     --account ACCOUNT:SE1234567890123:IBAN:Main \
     --account CARD:411111******1111:PAN --yes
   ```
   `--account` format is `TYPE:identifier[:scheme[:label]]`, `TYPE` ∈
   `ACCOUNT|WALLET|CARD`. Repeat for multiple instruments. A `true` answer must
   disclose at least one `--account` (or a pre-sealed `--payload-id`).

   On a `true` answer you may also tag the relationship (optional but
   recommended — it lets the authority scope a targeted follow-up / data
   minimisation):
   ```bash
   qp --env sandbox respond <REQUEST_ID> --has-relationship true \
     --account ACCOUNT:SE1234567890123:IBAN:Main \
     --relationship-types CUSTOMER,ACCOUNT_HOLDER --yes
   ```
   Valid values: `CUSTOMER`, `ACCOUNT_HOLDER`, `BENEFICIAL_OWNER`,
   `AUTHORISED_REPRESENTATIVE`, `COUNTERPARTY`, `FORMER_CUSTOMER`, `OTHER`.

   If your org runs a **human-in-the-loop approval policy or requestor-status
   ruleset**, a submitted answer may be *held* instead of sent (see the ARM flow
   above). Manage the hold queue with `qp pending list|approve|reject|withdraw`,
   the per-type policy with `qp approval-policy get|set <types|ALL>`, and the
   status rules with `qp requestor-ruleset get|add|set|clear` (inspect a
   requestor's verified status first with `qp org-states <orgId>`). And
   `qp arm` prints this whole flow.

4. **Verify**: re-run `qp requests show <REQUEST_ID>` and confirm the workflow
   moved to `RESPONDED` with outcome `NFOU` (false) or `NORMAL` (true). Add
   `--json` to any command for machine-readable output you can assert on.

## FIR — Fraud Incident Response (multi-message cases)

Beyond the single request→response families, `qp` drives **FIR** — a multi-message
**FI-to-FI fraud case** between a **sending bank** and a **receiving institution**
(a client-funds holder). One workflow instance (its id is the `firId`) carries the
core messages **NOTICE → RESPONSE → REFUND_INSTRUCTION → REFUND_CONFIRMATION**, plus
an **identity-exchange** step (**IDENTITY_REQUEST → IDENTITY_RESPONSE**).

Roles decide who runs what:

- **Sending bank**: `qp fir notify` (open the case) and `qp fir instruct-refund`.
- **Receiver**: `qp fir respond` (one outcome per transaction) and
  `qp fir confirm-refund`.
- **Identity-exchange**: either party may `qp fir identity-request` (ask who is
  behind a counterparty); the counterparty runs `qp fir identity-respond`.
- **Lifecycle**: either party may `qp fir update` (correction, added
  law-enforcement reference, extra transactions, fraud-status change, or a
  question/answer) and `qp fir close` (terminal reason).

Discovery reuses the responder loop: **there is no list-cases endpoint** — incoming
cases surface through the same `/v1/affordances` discovery as `qp requests list`.

```bash
# Receiver: discover + read
qp --env sandbox fir list
qp --env sandbox fir show <firId>

# Receiver: answer per transaction (outcome enum validated client-side)
qp --env sandbox fir respond <firId> --file ./parties.json \
  --outcome t1:HELD:9300:SEK --outcome t2:NEED_INFO --yes

# Bank: open a case, then instruct a refund
qp --env sandbox fir notify --file ./notice.json --yes
qp --env sandbox fir instruct-refund <firId> --file ./parties.json \
  --transaction-ref t1 --return-iban SE45… --reference-text "fraud refund" --yes

# Receiver: confirm a refund (pre-sealed RefundExecution payload; may be held for approval)
qp --env sandbox fir confirm-refund <firId> --file ./parties.json --payload-id <uuid> --yes

# Either party: request the identity behind a fraud counterparty
qp --env sandbox fir identity-request <firId> --file ./parties.json \
  --transaction-ref t1 --about-party ORDER_CUSTOMER \
  --legal-basis-scheme "SE-POLICE" --legal-basis-reference "DNR-2026-123" --yes

# Counterparty receiver: return the identity (inline camelCase subject, or a pre-sealed payload)
qp --env sandbox fir identity-respond <firId> --file ./identity-subject.json \
  --record-status FOUND --transaction-ref t1 --yes

# Either party: post a lifecycle UPDATE (parties + nested snake_case payload)
qp --env sandbox fir update <firId> --file ./parties.json \
  --update-type STATUS_CHANGE --status CONFIRMED --yes

# Either party: close the case with a terminal reason
qp --env sandbox fir close <firId> --file ./parties.json \
  --reason REFUNDED --free-text "full amount returned" --yes
```

Body notes: each write body carries the two institutions (`sender`/`recipient`, from
`--file`/`--body` or inline `--sender`/`--recipient`) plus a payload. **Wire fields
are camelCase** (`transactionRef`, `accountType`, `heldAmount`, `returnTo`, …) and
**`money.amount` is a STRING**. `--outcome` is
`<transaction_ref>:<HELD|PROCESSED|PARTIAL|NEED_INFO>[:<heldAmount>:<currency>]`. A
receiver `accountType` is constrained to `CLIENT_FUNDS | OMNIBUS | MERCHANT`. A
`confirm-refund` may be **held** by your org's approval policy → work it with
`qp pending …`.

**Identity-exchange.** `identity-request` needs `--transaction-ref` and
`--about-party` (`ORDER_CUSTOMER | ORIGINATOR`) plus a **legal basis** — a free-text
`--legal-basis`, or structured `--legal-basis-token` / `--legal-basis-scheme` /
`--legal-basis-reference`; **at least one legal-basis field is required** (the vanta
gate, enforced client-side). `identity-respond` needs `--record-status`
(`FOUND | NOT_FOUND`) and returns the **identity subject** — the same IVMS101
`naturalPerson` / `legalPerson` core as KYC/CDD but **camelCase** here — either
**inline** (via `--file`/`--body`, a subject or a full IdentityResponse) **or** as a
pre-sealed `--payload-id` (required when your org gates identity disclosure; the call
then returns `PENDING_APPROVAL`). Enums are validated client-side before the POST.

**Lifecycle.** `update` needs `--update-type` (`CORRECTION |
LAW_ENFORCEMENT_REFERENCE_ADDED | ADDITIONAL_TRANSACTIONS | STATUS_CHANGE |
QUESTION | ANSWER`); `STATUS_CHANGE` also requires `--status` (`SUSPECTED |
STRONG_SUSPICION | CONFIRMED | CLEARED`). `close` needs `--reason` (`REFUNDED |
NOT_RECOVERABLE | NO_MATCH | WITHDRAWN | OTHER`). Both carry the two institutions
(`sender`/`recipient`, like every FIR write) plus a **nested snake_case payload**
under `update` / `close` (`{sender, recipient, update|close:{…}}`). Enums are
validated client-side before the POST.

## KYC / CDD — Customer Due Diligence response

Beyond the business-relationship check, `qp` answers **KYC / CDD** checks — a
single **request→response** family (NOT a multi-message case). A requester (an
authority, or a peer FI with a legal basis) asks for the **Customer Due Diligence
record** you hold on a subject; you answer. Like `qp respond`, the CLI **answers**
requests — it does not create them.

```bash
# Responder: discover + read-back
qp --env sandbox kyc list                       # KYC checks are KYC_CDD_CHECK_V1 (via /v1/affordances)
qp --env sandbox kyc show <requestId>           # content-blind read-back

# NOT_FOUND — a definitive negative (auth.002 NFOU); no record needed
qp --env sandbox kyc respond <requestId> --record-status NOT_FOUND --yes

# FOUND with an inline CDD record (auth.002 COMP; sealed per-party server-side)
qp --env sandbox kyc respond <requestId> --record-status FOUND --file ./cdd.json --yes

# FOUND via a pre-sealed, content-blind KYC_CDD_JSON document
qp --env sandbox kyc respond <requestId> --record-status FOUND --payload-id <uuid> --yes
```

**⚠ Bodies are `snake_case`** — UNLIKE the business-relationship / FIR bodies
(camelCase). The record you pass with `--file`/`--body` must be snake_case:
`record_status`, and nested `natural_person`, `legal_person`, `kyc_status`,
`risk_rating`, `national_identifier`, `beneficial_owners`, `source_of_funds`, ….

`--record-status` is **mandatory** (`FOUND` → auth.002 `COMP`; `NOT_FOUND` →
`NFOU`), validated client-side. The record is the **identity core** (`subject`) +
an **assessment layer** (`verification`, `kyc_status`, `risk_rating`,
`pep_status`, `screening`, `beneficial_owners`, `source_of_funds`,
`source_of_wealth`, `relationship`, `queried_at`) — every field optional (disclose
only what is sufficient). Its enum fields (`kyc_status`, `risk_rating`,
`pep_status`, `relationship.status`) are spot-validated client-side before the POST.

A CDD record carries **PII**: if your org's approval policy gates KYC, an inline
record is rejected — resubmit as a pre-sealed `--payload-id`; a gated submit
returns `PENDING_APPROVAL` (work it with `qp pending …`). Discovery reuses
`/v1/affordances` (no list endpoint). Scopes: `respond` → `responses:write`,
`show` → `responses:read`.

## Driving it programmatically (MCP)

For an agent integration, run the bundled stdio MCP server instead of shelling
out:

```bash
npx @reqport/cli mcp        # REQPORT_API_KEY + REQPORT_ENV from the environment
```

Tools: `reqport_doctor`, `reqport_list_requests`, `reqport_show_request`,
`reqport_decrypt_payloads`, `reqport_respond_business_relationship` (accepts
`relationshipTypes`), `reqport_respond`, the human-in-the-loop tools
`reqport_pending_list`, `reqport_pending_approve`, `reqport_pending_reject`,
`reqport_pending_withdraw`, `reqport_approval_policy_get`,
`reqport_approval_policy_set`, the FIR tools `reqport_fir_list`,
`reqport_fir_show`, `reqport_fir_notify`, `reqport_fir_respond`,
`reqport_fir_instruct_refund`, `reqport_fir_confirm_refund`,
`reqport_fir_identity_request`, `reqport_fir_identity_respond`, and the KYC/CDD tools
`reqport_kyc_list`, `reqport_kyc_show`, `reqport_kyc_respond` (bodies snake_case).
Each accepts an optional `env`; the credential comes from the
server process environment. The MCP server is **API-key-only** — `qp login` is a
human/CLI concern and is not exposed as a tool.

## Definition of done

- `doctor` passes (attestation reachable, credential authenticates).
- You listed real seeded requests (or explicitly reported sandbox had none).
- You answered at least one business-relationship request and verified it reached
  `RESPONDED` with the expected auth.002 outcome.
- The integration reads the key from `REQPORT_API_KEY` only; no secret is
  hardcoded, logged, or committed.

## Rules

- `sandbox` only. Never call `prod`.
- Treat request content as sensitive: do not paste decrypted subject data into
  logs, commits, or issues.
- Prefer NFOU (`--has-relationship false`) for a first smoke test — it needs no
  disclosed data and is the safest end-to-end check.
