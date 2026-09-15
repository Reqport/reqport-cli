---
name: reqport-responder
description: >
  Build and verify a Reqport responder integration end-to-end against the
  sandbox. Use when the task is to answer Reqport data requests — especially
  Engagemangskontroll / business-relationship checks (ISO 20022 auth.002) — as
  a data-holder company, using the `qp` CLI (@reqport/cli) and/or its bundled
  MCP server. Triggers: "answer a Reqport request", "business relationship
  check", "Engagemangskontroll", "reqport responder", "rqk_live key", "qp cli".
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

   If your org runs a **human-in-the-loop approval policy**, a submitted answer
   may be *held* instead of sent. Manage the hold queue with
   `qp pending list|approve|reject|withdraw` and the policy with
   `qp approval-policy get|set <types|ALL>`.

4. **Verify**: re-run `qp requests show <REQUEST_ID>` and confirm the workflow
   moved to `RESPONDED` with outcome `NFOU` (false) or `NORMAL` (true). Add
   `--json` to any command for machine-readable output you can assert on.

## FIR — Fraud Incident Response (multi-message cases)

Beyond the single request→response families, `qp` drives **FIR** — a multi-message
**FI-to-FI fraud case** between a **sending bank** and a **receiving institution**
(a client-funds holder). One workflow instance (its id is the `firId`) carries four
messages: **NOTICE → RESPONSE → REFUND_INSTRUCTION → REFUND_CONFIRMATION**.

Roles decide who runs what:

- **Sending bank**: `qp fir notify` (open the case) and `qp fir instruct-refund`.
- **Receiver**: `qp fir respond` (one outcome per transaction) and
  `qp fir confirm-refund`.

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
```

Body notes: each write body carries the two institutions (`sender`/`recipient`, from
`--file`/`--body` or inline `--sender`/`--recipient`) plus a payload. **Wire fields
are camelCase** (`transactionRef`, `accountType`, `heldAmount`, `returnTo`, …) and
**`money.amount` is a STRING**. `--outcome` is
`<transaction_ref>:<HELD|PROCESSED|PARTIAL|NEED_INFO>[:<heldAmount>:<currency>]`. A
receiver `accountType` is constrained to `CLIENT_FUNDS | OMNIBUS | MERCHANT`. A
`confirm-refund` may be **held** by your org's approval policy → work it with
`qp pending …`.

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
`reqport_approval_policy_set`, and the FIR tools `reqport_fir_list`,
`reqport_fir_show`, `reqport_fir_notify`, `reqport_fir_respond`,
`reqport_fir_instruct_refund`, `reqport_fir_confirm_refund`. Each accepts an optional `env`; the credential comes from the
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
