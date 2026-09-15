# @reqport/cli — `qp`

[![npm version](https://img.shields.io/npm/v/@reqport/cli.svg)](https://www.npmjs.com/package/@reqport/cli)
[![node](https://img.shields.io/node/v/@reqport/cli.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/npm/l/@reqport/cli.svg)](./LICENSE)
[![published with provenance](https://img.shields.io/badge/npm-provenance-cb0000.svg)](https://docs.npmjs.com/generating-provenance-statements)
[![MCP server](https://img.shields.io/badge/MCP-server-5b50e0.svg)](https://modelcontextprotocol.io)

The official command-line client + MCP server for **[Reqport](https://reqport.com)** —
a publishable `npx` CLI (binary: **`qp`**) for Reqport **responders** — the data-holder side. Discover the requests addressed to
your organisation, read them, and answer them (e.g. **Engagemangskontroll** /
business-relationship checks as ISO 20022 **auth.002**). Humans can pair the CLI
with the Reqport console (`qp login`) to receive an API key without copy-pasting
from a web page.

```bash
# Automation (agents / CI): use an API key
export REQPORT_API_KEY="rqk_live_..."          # PowerShell: $env:REQPORT_API_KEY="..."
npx @reqport/cli --env sandbox doctor          # the bin is `qp`

# Humans: pair with the console — a browser opens, you approve, the key returns here
qp login --env sandbox
qp --env sandbox doctor
```

> The package is `@reqport/cli`; the single binary it installs is **`qp`**, so
> `npx @reqport/cli …` and `qp …` are equivalent.

## Why it's thin (the content-blind model)

Reqport stores only ciphertext, but the **responder loop is server-assisted**, so
this CLI is just HTTP + an API key — **no client-side crypto**:

| Step | Endpoint | Who decrypts / seals |
|------|----------|----------------------|
| Read a request | `POST /v1/payloads/decrypt-batch` | The **TEE** decrypts in-enclave and returns plaintext to your authorized key |
| Answer (yes/no + accounts) | `POST /v1/requests/{id}/business-relationship-response` | The **TEE** seals the answer server-side |

No Model-1 dual-JWE, device keys, or DPoP are needed for this loop. (Uploading a
*sealed answer document* for the generic structured `/response` path is the only
flow that would require client-side encryption; it is intentionally not
implemented here.)

## Credentials

The CLI authenticates with an **`rqk_live_` API key** on every call. Two ways to
get one onto a machine:

- **Set `REQPORT_API_KEY`** — for automation (agents / CI). Read at runtime only;
  never a flag, never logged. Needs scopes **`payloads:read`** + **`responses:write`**
  for the responder loop.
- **`qp login`** (portal pairing) — for humans. A browser opens the Reqport
  console's CLI-auth page (which reuses your existing console session), you match
  a short confirmation code and approve, and the console mints a key and relays it
  back to the terminal, where it's stored as the active credential. **No new OAuth
  client, no device flow, no localhost callback, no password ever seen by the CLI.**

Precedence for `requests` / `respond`: `REQPORT_API_KEY` first, else the stored
paired key. **Agents/CI should always use `REQPORT_API_KEY`.**

The stored key lives at **`%APPDATA%\qp\credential.json`** (Windows) or
**`$XDG_CONFIG_HOME/qp/credential.json`** → `~/.config/qp/credential.json`
(macOS/Linux), written `0600` (best-effort on Windows). `qp logout` clears it;
`qp whoami` shows its env / key id / scopes (local only).

## Environments

`--env sandbox|uat|prod` (default `sandbox`, or `REQPORT_ENV`):

- `sandbox` → `https://sandbox.reqport.com/vanta`
- `uat` → `https://vanta.dev-uat.reqport.com/vanta`
- `prod` → `https://vanta.reqport.com/vanta`

## Commands

| Command | What it does |
|---------|--------------|
| `qp login [--env] [--portal-url <url>] [--name <keyName>]` | Pair with the console; receive + store an API key |
| `qp logout` / `qp whoami` | Clear / show the stored key (local only) |
| `qp doctor` | Verify base URL, TEE attestation, and that your credential authenticates |
| `qp requests list [--state open] [--type <t>] [--mine]` | Discover requests via `/v1/affordances` |
| `qp requests show <id>` | Read one request; decrypts its content in the TEE |
| `qp respond <id> …` | Answer — auto-detects business-relationship vs generic |
| `qp pending list` | List this org's held responses awaiting approval |
| `qp pending approve\|reject\|withdraw <id>` | Release / reject / withdraw a held response |
| `qp approval-policy get\|set <types>` | Show / set which response types require approval before send |
| `qp fir list [--state open] [--mine]` | Discover **FIR** (Fraud Incident Response) cases addressed to you |
| `qp fir show <firId>` | Read a FIR case (content-blind metadata) |
| `qp fir notify --file <notice.json>` | Open a FIR case with a NOTICE (sending-bank side) |
| `qp fir respond <firId> --outcome …` | Answer a NOTICE with per-transaction outcomes (receiver side) |
| `qp fir instruct-refund <firId> …` | Instruct a refund of a held transaction (bank side) |
| `qp fir confirm-refund <firId> --payload-id <uuid>` | Confirm a refund executed (receiver side) |
| `qp fir identity-request <firId> --transaction-ref … --about-party … --legal-basis …` | Request the identity behind a fraud counterparty (either side) |
| `qp fir identity-respond <firId> --record-status FOUND\|NOT_FOUND …` | Return that identity (receiver side) — inline subject or a pre-sealed payload |
| `qp fir update <firId> --update-type …` | Post a lifecycle UPDATE (correction / law-enforcement ref / added transactions / status change / question / answer; either party) |
| `qp fir close <firId> --reason …` | Close a FIR case with a terminal reason (either party) |
| `qp kyc list [--state open] [--mine]` | Discover **KYC / CDD** checks addressed to you |
| `qp kyc show <requestId>` | Content-blind read-back of a KYC/CDD response |
| `qp kyc respond <requestId> --record-status FOUND\|NOT_FOUND …` | Answer a KYC/CDD request with the CDD record |
| `qp keys status` | Show the active credential's metadata (local only) |
| `qp keys create\|list\|revoke` | Points you to the console — key management is not a CLI operation |
| `qp mcp` | Run the stdio MCP server |

Global flags: `--env`, `--json` (machine-readable output on every command).

### `qp login` (portal pairing)

```bash
qp login --env sandbox                          # default portal https://reqport.com
qp login --env sandbox --portal-url https://sandbox.reqport.com --name my-laptop
```

The CLI prints a confirmation code, opens
`{portalUrl}/{locale}/developer/cli-auth?state=…&challenge=…&env=…`, and polls
`{portalUrl}/api/developer/cli-auth/poll` until the console relays the key (or you
Ctrl+C). Override the portal with `--portal-url` / `QP_PORTAL_URL` (e.g. for
sandbox or aurora); locale via `QP_LOCALE` (default `en`).

### Key management is in the console

Minting, listing, and revoking keys is done by a signed-in human in the developer
console (`{portalUrl}/{locale}/developer`). The CLI holds only an API key, and
Vanta's key-management endpoints are HUMAN-only (Signicat + ORG_ADMIN) — an API
key cannot call them — so `qp keys create|list|revoke` simply point you there.

### Answering

```bash
# Business relationship check
qp respond <id> --has-relationship false --yes                       # auth.002 NFOU
qp respond <id> --has-relationship true \
  --account ACCOUNT:SE1234567890123:IBAN:Main \
  --account CARD:411111******1111:PAN --yes                          # auth.002 COMP

# ...optionally tag the relationship (recommended — enables a targeted follow-up)
qp respond <id> --has-relationship true \
  --account ACCOUNT:SE1234567890123:IBAN:Main \
  --relationship-types CUSTOMER,ACCOUNT_HOLDER --yes

# Generic request
qp respond <id> --status NFOU --yes
qp respond <id> --status COMP --free-text "See attached statement." --yes
```

`--account` = `TYPE:identifier[:scheme[:label]]`, `TYPE` ∈ `ACCOUNT|WALLET|CARD`,
repeatable. A `true`/`COMP` answer must disclose at least one account (or a
pre-sealed `--payload-id`).

`--relationship-types` = comma-separated tags attached to a **true**
business-relationship answer (ignored/omitted on a `false` answer). Optional but
recommended: it lets the requesting authority scope a targeted follow-up (data
minimisation). Valid values (exact): `CUSTOMER`, `ACCOUNT_HOLDER`,
`BENEFICIAL_OWNER`, `AUTHORISED_REPRESENTATIVE`, `COUNTERPARTY`,
`FORMER_CUSTOMER`, `OTHER`.

### Approval (human-in-the-loop)

An org can require that some (or all) response types are **approved by a human**
before they are sealed + sent. Submitted answers that match the policy are *held*
until an approver releases them.

```bash
# See / set which response types require approval (sentinel ALL = every type)
qp approval-policy get
qp approval-policy set BUSINESS_RELATIONSHIP_RESPONSE
qp approval-policy set ALL

# Work the hold queue
qp pending list                          # id, request id, response type, auth.002 status, submitter, created
qp pending approve <id>                  # release — seal + send happens server-side
qp pending reject  <id> --reason "…"
qp pending withdraw <id>                 # submitter withdraws their own held response
```

`approve` / `reject` / `withdraw` are irreversible and prompt for confirmation on
an interactive terminal; pass `-y`/`--yes` (or `--json`) to skip the prompt.

Endpoints (all under the env's Vanta base, auth = your `rqk_live_` key):
`GET /v1/responses/pending` (`responses:read`),
`POST /v1/responses/pending/{id}/{approve|reject|withdraw}` (`responses:write`),
`GET`/`PUT /v1/responses/approval-policy` (`responses:read`/`responses:write`).

## FIR — Fraud Incident Response

A **FIR** is a multi-message **FI-to-FI fraud case** between a **sending bank** and
a **receiving institution** (a client-funds holder such as an exchange). Unlike the
single request→response families, a FIR case is one workflow instance (its id is the
`firId`) that carries the P0 messages plus an **identity-exchange** step over time:

| Step | Command | Role | Endpoint |
|------|---------|------|----------|
| **NOTICE** | `qp fir notify` | sending **bank** | `POST /v1/fir/cases` |
| **RESPONSE** | `qp fir respond <firId>` | **receiver** | `POST /v1/fir/cases/{firId}/response` |
| **REFUND_INSTRUCTION** | `qp fir instruct-refund <firId>` | sending **bank** | `POST /v1/fir/cases/{firId}/refund-instruction` |
| **REFUND_CONFIRMATION** | `qp fir confirm-refund <firId>` | **receiver** | `POST /v1/fir/cases/{firId}/refund-confirmation` |
| **IDENTITY_REQUEST** | `qp fir identity-request <firId>` | either party | `POST /v1/fir/cases/{firId}/identity-request` |
| **IDENTITY_RESPONSE** | `qp fir identity-respond <firId>` | counterparty **receiver** | `POST /v1/fir/cases/{firId}/identity-response` |
| **UPDATE** | `qp fir update <firId>` | either party | `POST /v1/fir/cases/{firId}/update` |
| **CLOSE** | `qp fir close <firId>` | either party | `POST /v1/fir/cases/{firId}/close` |
| read a case | `qp fir show <firId>` | either party | `GET /v1/fir/cases/{firId}` |

**Roles.** The **bank** opens the case (`notify`) and later authorises refunds
(`instruct-refund`). The **receiver** answers per-transaction (`respond`, one of
`HELD | PROCESSED | PARTIAL | NEED_INFO`) and confirms a refund executed
(`confirm-refund`). Everything is sealed dual-copy server-side — the CLI stays a
thin HTTP client (no client crypto).

**Discovery.** There is **no list-cases endpoint.** A receiver discovers incoming
cases through the **same `/v1/affordances`** discovery `qp requests list` uses — FIR
cases are `FIR_FRAUD_CASE_V1` workflow instances addressed to the receiver.
`qp fir list` filters that discovery down to FIR cases and labels them.

```bash
# Receiver: find + read incoming cases
qp fir list
qp fir show <firId>
```

### Bodies: institutions + a payload

Every write body carries the two **institutions** (`sender`, `recipient`, each a
self-declared identity object) plus a payload. Institutions come from a
`--file <path>` / `--body <inline JSON>` base body, or inline via
`--sender`/`--recipient`; the payload can be built with convenience flags. **Wire
field names are camelCase** (`transactionRef`, `accountType`, `heldAmount`,
`returnTo`, `recipientOrgId`, …) and **`money.amount` is always a decimal STRING**.

```bash
# BANK: open a case (the nested NOTICE is easiest as a file)
qp fir notify --file ./notice.json
#   notice.json = {"sender":{…},"recipient":{…},"recipientOrgId":"ORG_RECV",
#                  "notice":{"status":"SUSPECTED","requestedAction":"HOLD_FUNDS",
#                    "transactions":[{"transactionRef":"t1","rail":"INSTANT_CREDIT_TRANSFER",
#                      "amount":{"amount":"9300","currency":"SEK"},"executedAt":"2026-08-27T09:00:00Z",
#                      "receiver":{"accountType":"OMNIBUS","label":"klientmedel"}}]}}

# RECEIVER: answer per transaction (outcomes via repeatable flags)
qp fir respond <firId> --file ./parties.json \
  --outcome t1:HELD:9300:SEK \
  --outcome t2:NEED_INFO --note "one held, one needs info"
#   --outcome <transaction_ref>:<HELD|PROCESSED|PARTIAL|NEED_INFO>[:<heldAmount>:<currency>]
#   parties.json = {"sender":{…receiver institution…},"recipient":{…bank…}}

# BANK: instruct a refund of a held transaction
qp fir instruct-refund <firId> --file ./parties.json \
  --transaction-ref t1 \
  --return-iban SE45… --return-label "victim IBAN" \
  --reference-text "fraud refund t1"

# RECEIVER: confirm the refund executed (carry a pre-sealed RefundExecution payload)
qp fir confirm-refund <firId> --file ./parties.json --payload-id <uuid>
```

**`--outcome`** validates the outcome enum client-side (listing valid values on
error) before the POST; a held amount, when given, needs **both** amount and
currency and is carried as a string. **`notify`** validates the required top-level
fields and constrains each transaction's `receiver.accountType` to
`CLIENT_FUNDS | OMNIBUS | MERCHANT` (a receiver account is pooled / non-personal).

**Confirm-refund and the approval hold.** A `confirm-refund` carries a
**pre-sealed** `RefundExecution` (docType `FIR_REFUND_JSON`) as a `--payload-id` —
sensitive refund detail is never inlined. That lets the receiver's per-type
[approval policy](#approval-human-in-the-loop) hold it for human review: when gated
the call returns `PENDING_APPROVAL` (release it with `qp pending approve <id>`);
otherwise it releases immediately.

### Identity-exchange (`identity-request` / `identity-response`)

Once funds are held, a party may need the **identity behind a fraud-transaction
counterparty** — the person or entity on the other side of a reported payment.
That is a two-message exchange on the same case:

```bash
# EITHER PARTY: ask who is behind a transaction's counterparty
qp fir identity-request <firId> --file ./parties.json \
  --transaction-ref t1 --about-party ORDER_CUSTOMER \
  --legal-basis-scheme "SE-POLICE" --legal-basis-reference "DNR-2026-123" \
  --requested-attribute name --requested-attribute dateOfBirth
#   --about-party is ORDER_CUSTOMER | ORIGINATOR (validated client-side)
#   legal basis: a free-text --legal-basis, OR structured
#   --legal-basis-token / --legal-basis-scheme / --legal-basis-reference —
#   at least one field is REQUIRED (the vanta gate, mirrored client-side)

# COUNTERPARTY RECEIVER: return the identity inline (the KYC/IVMS101 subject core)
qp fir identity-respond <firId> --file ./identity-subject.json \
  --record-status FOUND --transaction-ref t1
#   identity-subject.json = {"naturalPerson":{"name":{"primary":"Andersson",
#     "secondary":"Anna"},"dateOfBirth":"1985-04-02","nationality":"SE"}}
#   (a legalPerson subject is the same shape as KYC's legal_person, camelCase)

# …or return a pre-sealed identity document instead of inlining PII
qp fir identity-respond <firId> --sender '{…}' --recipient '{…}' \
  --record-status FOUND --transaction-ref t1 --payload-id <uuid>

# …or decline: no counterparty on record
qp fir identity-respond <firId> --sender '{…}' --recipient '{…}' \
  --record-status NOT_FOUND --transaction-ref t1
```

The **identity subject** is the same IVMS101 identity core as
[KYC / CDD](#kyc--cdd--customer-due-diligence-response) — `naturalPerson` OR
`legalPerson` — but **camelCase** here (matching the FIR wire idiom), not KYC's
snake_case. Supply it **inline** under `identityResponse.subject` (server-sealed
per-party) **OR** as a pre-sealed `--payload-id` — the pre-sealed form is required
when your org's [approval policy](#approval-human-in-the-loop) gates identity
disclosure (no cleartext PII may be held); a gated call returns `PENDING_APPROVAL`.
`--record-status` (`FOUND | NOT_FOUND`) and `--about-party` are validated
client-side before the POST.

### Lifecycle (`update` / `close`)

Either party can post a lifecycle message on an open case. Unlike the other FIR
bodies, the **`update` / `close` bodies are snake_case** on the wire and carry
**no `sender`/`recipient`** — the case parties are already fixed by the workflow
instance.

```bash
# EITHER PARTY: correct or extend the case (six update_types)
qp fir update <firId> --update-type STATUS_CHANGE --status CONFIRMED
qp fir update <firId> --update-type LAW_ENFORCEMENT_REFERENCE_ADDED \
  --law-enforcement-scheme "SE-POLICE" --law-enforcement-reference "DNR-2026-123"
qp fir update <firId> --update-type ADDITIONAL_TRANSACTIONS \
  --transactions '[{"transactionRef":"t3","amount":{"amount":"500","currency":"SEK"}}]'
qp fir update <firId> --update-type QUESTION --free-text "Any hold on t2 yet?"
#   --update-type is CORRECTION | LAW_ENFORCEMENT_REFERENCE_ADDED |
#     ADDITIONAL_TRANSACTIONS | STATUS_CHANGE | QUESTION | ANSWER (validated)
#   STATUS_CHANGE REQUIRES --status (SUSPECTED|STRONG_SUSPICION|CONFIRMED|CLEARED)

# EITHER PARTY: close the case with a terminal reason
qp fir close <firId> --reason REFUNDED --free-text "full amount returned"
#   --reason is REFUNDED | NOT_RECOVERABLE | NO_MATCH | WITHDRAWN | OTHER (validated)
```

`--update-type` / `--status` / `--reason` are validated client-side (listing the
valid values on error) before the POST, and `update --update-type STATUS_CHANGE`
fails fast when `--status` is omitted. Both bodies can also be supplied whole via
`--file` / `--body` (snake_case keys); flags override.

The mutating FIR commands (`notify`, `respond`, `instruct-refund`,
`confirm-refund`, `identity-request`, `identity-respond`, `update`, `close`)
prompt for confirmation on an interactive terminal; pass `-y`/`--yes` (or `--json`)
to skip. Scopes: `notify` / `instruct-refund` / `identity-request` / `update` /
`close` need `workflows:write`; `respond` / `confirm-refund` / `identity-respond`
ride the response path (`responses:write`); `show` / `list` need `workflows:read`
/ discovery.

## KYC / CDD — Customer Due Diligence response

A **KYC / CDD** check is a single **request→response** family (like the
business-relationship check), **not** a multi-message case: a requester (an
authority, or a peer FI carrying a legal basis) asks a bank or exchange for the
**Customer Due Diligence record** it holds on a subject, and the responder
answers. Like `qp respond`, the CLI answers requests — it does **not** create them.

| Step | Command | Endpoint |
|------|---------|----------|
| discover checks addressed to you | `qp kyc list` | `GET /v1/affordances` (filtered) |
| read back one answer (content-blind) | `qp kyc show <requestId>` | `GET /v1/requests/{id}/kyc-response` |
| submit the CDD record | `qp kyc respond <requestId>` | `POST /v1/requests/{id}/kyc-response` |

**Discovery.** There is **no list endpoint.** KYC checks are `KYC_CDD_CHECK_V1`
workflow instances that surface through the **same `/v1/affordances`** discovery
`qp requests list` uses; `qp kyc list` filters that down to KYC checks and labels
them.

> **⚠ Bodies are `snake_case`.** UNLIKE the rest of this CLI (and unlike FIR, which
> is camelCase), the KYC request body is **snake_case** — `record_status`,
> `payload_id`, and every nested `CddRecord` field (`natural_person`, `kyc_status`,
> `risk_rating`, `national_identifier`, `beneficial_owners`, `source_of_funds`, …).
> The record you pass with `--file`/`--body` must be snake_case JSON.

```bash
# Responder: discover + read
qp kyc list
qp kyc show <requestId>

# NOT_FOUND — a definitive negative (auth.002 NFOU); no record needed
qp kyc respond <requestId> --record-status NOT_FOUND --yes

# FOUND with an inline CDD record (auth.002 COMP; sealed per-party server-side)
qp kyc respond <requestId> --record-status FOUND --file ./cdd.json --yes
#   cdd.json (snake_case) = {
#     "subject": { "natural_person": {
#       "name": { "primary": "Andersson", "secondary": "Anna" },
#       "date_of_birth": "1985-04-12", "nationality": "SE",
#       "national_identifier": { "scheme": "SE_PERSONNUMMER", "value": "…" } } },
#     "verification": { "method": "BANK_ID", "level": "ENHANCED" },
#     "kyc_status": "VERIFIED", "risk_rating": "LOW", "pep_status": "NONE",
#     "relationship": { "status": "ACTIVE", "onboarded_at": "2021-02-01T00:00:00Z" },
#     "queried_at": "2026-08-28T09:00:00Z" }

# FOUND via a pre-sealed, content-blind KYC_CDD_JSON document
qp kyc respond <requestId> --record-status FOUND --payload-id <uuid> --yes
```

**`--record-status` is mandatory** and validated client-side against `FOUND |
NOT_FOUND` (`FOUND` → auth.002 `COMP`; `NOT_FOUND` → `NFOU`). The record is the
**identity core** (`subject`, a natural or legal person) plus an **assessment
layer** (`verification`, `kyc_status`, `risk_rating` + `risk_factors`,
`pep_status` + `pep_position`, `screening`, `beneficial_owners`,
`source_of_funds`, `source_of_wealth`, `relationship`, `queried_at`) — every field
optional; disclose only what is sufficient (data minimisation). When a record is
given, its enum fields (`kyc_status`, `risk_rating`, `pep_status`,
`relationship.status`) are **spot-validated client-side** before the POST.

**Inline vs pre-sealed.** Supply the record **inline** with `--file <cdd.json>` /
`--body <inline JSON>` (Vanta seals the assembled response per-party in the
`RESPONSE_HEADER`), **or** as a pre-sealed `--payload-id` (a validated,
content-blind `KYC_CDD_JSON` document Vanta never sees) — not both. A CDD record
carries **PII**: if your org's [approval policy](#approval-human-in-the-loop)
gates KYC, an **inline** record is rejected (no cleartext PII may be held) and you
must resubmit as a pre-sealed `--payload-id`; the gated submit returns
`PENDING_APPROVAL` (release with `qp pending approve <id>`).

`qp kyc respond` prompts for confirmation on an interactive terminal; pass
`-y`/`--yes` (or `--json`) to skip. Scopes: `respond` needs `responses:write`;
`show` needs `responses:read`; `list` uses discovery.

## The `qp login` ↔ portal pairing contract

The portal implements the server half; the CLI implements this half. For reference:

1. **CLI** generates a secret `verifier` + random `state`, and
   `challenge = base64url(SHA256(verifier))`. It prints a confirmation code (the
   first 8 chars of `state`) and opens
   `GET {portalUrl}/{locale}/developer/cli-auth?state={state}&challenge={challenge}&env={env}[&name={name}]`.
2. The **human** (already signed in to the console) verifies the code matches and
   approves. The portal mints an `rqk_live_` key bound to `state`.
3. **CLI** polls `POST {portalUrl}/api/developer/cli-auth/poll` with
   `{state, verifier}` every ~2.5s (5-min timeout, clean Ctrl+C):
   - `202 {status:"pending"}` → keep polling
   - `200 {status:"ready", apiKey, keyId, env, scopes, expiresAt}` → store & stop
   - `403` (verifier mismatch) / `404` (no session) / `410` (expired) → abort with a clear message
4. CLI stores `{value: apiKey, kind:"apikey", env, keyId, scopes, expiresAt}` as
   the active credential.

The portal authenticates the caller by requiring proof of `verifier` (whose
SHA-256 it received as `challenge`), so the minted key is only handed to the
client that started the pairing.

## MCP server

```bash
npx @reqport/cli mcp
```

A stdio MCP server (official `@modelcontextprotocol/sdk`) exposing the same
responder operations, built on the same client. **API-key-only by design** — an
agent cannot complete an interactive console pairing, so `qp login` is human/CLI
only. Configure the key in the server env:

```json
{
  "mcpServers": {
    "reqport": {
      "command": "npx",
      "args": ["-y", "@reqport/cli", "mcp"],
      "env": { "REQPORT_API_KEY": "rqk_live_...", "REQPORT_ENV": "sandbox" }
    }
  }
}
```

Tools: `reqport_doctor`, `reqport_list_requests`, `reqport_show_request`,
`reqport_decrypt_payloads`, `reqport_respond_business_relationship` (accepts
`relationshipTypes`), `reqport_respond`, `reqport_pending_list`,
`reqport_pending_approve`, `reqport_pending_reject`, `reqport_pending_withdraw`,
`reqport_approval_policy_get`, `reqport_approval_policy_set`, the **FIR** tools
`reqport_fir_list`, `reqport_fir_show`, `reqport_fir_notify`, `reqport_fir_respond`,
`reqport_fir_instruct_refund`, `reqport_fir_confirm_refund`,
`reqport_fir_identity_request`, `reqport_fir_identity_respond`, the **KYC / CDD** tools
`reqport_kyc_list`, `reqport_kyc_show`, `reqport_kyc_respond` (bodies snake_case),
and the chat + attachment tools.

## Give this to your agent

Paste this into a coding agent (Claude Code, Cursor, …) to build a responder
integration end-to-end against the sandbox:

> You are integrating our company as a **Reqport responder**. Use the `qp` CLI
> (`npx @reqport/cli` installs the `qp` binary). Reqport is content-blind but the
> responder loop is **server-assisted**, so you do **not** write any encryption
> code — reads decrypt in the TEE and answers are sealed server-side.
>
> 1. I will export `REQPORT_API_KEY` (an `rqk_live_` sandbox key). Never print,
>    hardcode, or commit it. Always use `--env sandbox`; never call prod. (If I
>    have not given you a key, ask me to run `qp login --env sandbox` — a browser
>    pairing with the console — or to make one on the console `/developer` page,
>    and I'll export it for you.)
> 2. Run `qp --env sandbox doctor` and confirm attestation + auth pass.
> 3. Run `qp --env sandbox requests list` to find open requests addressed to us.
>    Sandbox is seeded by a synthetic authority (`reqport-authority-test.com`); if
>    the list is empty, tell me — do not invent data.
> 4. For a business-relationship check: `qp requests show <id>` to read it, then
>    `qp respond <id> --has-relationship false --yes` (no customer → auth.002 NFOU)
>    or `qp respond <id> --has-relationship true --account ACCOUNT:<iban>:IBAN:<label> --yes`
>    (→ auth.002 COMP, accounts sealed in the TEE).
> 5. Verify with `qp requests show <id> --json` that status is `RESPONDED` with the
>    expected outcome. Use `--json` throughout for assertable output.
>
> If you prefer tool calls over shell, run `npx @reqport/cli mcp` (a stdio MCP
> server with the same operations) configured with `REQPORT_API_KEY` +
> `REQPORT_ENV=sandbox` in its env.

An agent skill is bundled at `.claude/skills/reqport-responder/SKILL.md`.

## Development

```bash
npm install        # also builds via prepare
npm run build      # tsc → dist/
npm run dev -- --env sandbox doctor   # run from source with tsx
```

Node >= 18. Uses the built-in global `fetch`; no network dependency beyond it.
Exact-pinned deps: `commander`, `@modelcontextprotocol/sdk`, `zod`.

### Releasing

Releases publish to npm via **OIDC Trusted Publishing** with **provenance** — no
long-lived token in CI. Bump `version`, push a matching `v*` tag, and
`.github/workflows/release.yml` builds and runs `npm publish --provenance` under
the workflow's OIDC identity. This requires a one-time **Trusted Publisher** entry
(`Reqport/reqport-cli` + `release.yml`) configured on the npm package's settings
page. Until a release is published, run locally with `node dist/index.js …` or
`npm link`.

---

**Links** · [npm](https://www.npmjs.com/package/@reqport/cli) · [Developer docs](https://reqport.com/en/developer) · [Source](https://github.com/Reqport/reqport-cli) · [Report an issue](https://github.com/Reqport/reqport-cli/issues)

Built by **[Reqport](https://reqport.com)**. Licensed under [MIT](./LICENSE).
