# @reqport/cli — `qp`

A publishable `npx` CLI (binary: **`qp`**) **and** bundled **MCP server** for
Reqport **responders** — the data-holder side. Discover the requests addressed to
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

# Generic request
qp respond <id> --status NFOU --yes
qp respond <id> --status COMP --free-text "See attached statement." --yes
```

`--account` = `TYPE:identifier[:scheme[:label]]`, `TYPE` ∈ `ACCOUNT|WALLET|CARD`,
repeatable. A `true`/`COMP` answer must disclose at least one account (or a
pre-sealed `--payload-id`).

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
`reqport_decrypt_payloads`, `reqport_respond_business_relationship`,
`reqport_respond`.

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

> Not yet published to npm. Until then, run locally with `node dist/index.js …`
> or `npm link`. Publishing is gated on the maintainer's go-ahead.
