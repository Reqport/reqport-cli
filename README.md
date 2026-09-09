# @reqport/cli

A publishable `npx` CLI **and** bundled **MCP server** for Reqport **responders** —
the data-holder side. Discover the requests addressed to your organisation, read
them, and answer them (e.g. **Engagemangskontroll** / business-relationship checks
as ISO 20022 **auth.002**), using an `rqk_live_` API key.

```bash
export REQPORT_API_KEY="rqk_live_..."          # PowerShell: $env:REQPORT_API_KEY="..."
npx @reqport/cli --env sandbox doctor
npx @reqport/cli --env sandbox requests list
npx @reqport/cli --env sandbox respond <id> --has-relationship false --yes
```

## Why it's thin (the content-blind model)

Reqport stores only ciphertext, but the **responder loop is server-assisted**, so
this CLI is just HTTP + your key — **no client-side crypto**:

| Step | Endpoint | Who decrypts / seals |
|------|----------|----------------------|
| Read a request | `POST /v1/payloads/decrypt-batch` | The **TEE** decrypts in-enclave and returns plaintext to your authorized key |
| Answer (yes/no + accounts) | `POST /v1/requests/{id}/business-relationship-response` | The **TEE** seals the answer server-side |

No Model-1 dual-JWE, device keys, or DPoP are needed for this loop. (Uploading a
*sealed answer document* for the generic structured `/response` path is the only
flow that would require client-side encryption; it is intentionally not
implemented here.)

## Auth & environments

- Key: `rqk_live_...` M2M key, read from **`REQPORT_API_KEY`** at runtime only.
  Never a flag, never logged. Needs scopes **`payloads:read`** + **`responses:write`**.
- `--env sandbox|uat|prod` (default `sandbox`, or `REQPORT_ENV`):
  - `sandbox` → `https://sandbox.reqport.com/vanta`
  - `uat` → `https://vanta.dev-uat.reqport.com/vanta`
  - `prod` → `https://vanta.reqport.com/vanta`
- Key **management** (create/list/revoke) is portal-only (`/developer`, human
  login). This CLI never handles a Signicat JWT.

## Commands

| Command | What it does |
|---------|--------------|
| `reqport doctor` | Verify base URL, TEE attestation, and that your key authenticates |
| `reqport requests list [--state open] [--type <t>] [--mine]` | Discover requests via `/v1/affordances` |
| `reqport requests show <id>` | Read one request; decrypts its content in the TEE |
| `reqport respond <id> …` | Answer — auto-detects business-relationship vs generic |
| `reqport keys [status]` | Show the key in use (masked) and whether it authenticates |
| `reqport mcp` | Run the stdio MCP server |

Global flags: `--env`, `--json` (machine-readable output on every command).

### Answering

```bash
# Business relationship check
reqport respond <id> --has-relationship false --yes                       # auth.002 NFOU
reqport respond <id> --has-relationship true \
  --account ACCOUNT:SE1234567890123:IBAN:Main \
  --account CARD:411111******1111:PAN --yes                               # auth.002 COMP

# Generic request
reqport respond <id> --status NFOU --yes
reqport respond <id> --status COMP --free-text "See attached statement." --yes
```

`--account` = `TYPE:identifier[:scheme[:label]]`, `TYPE` ∈ `ACCOUNT|WALLET|CARD`,
repeatable. A `true`/`COMP` answer must disclose at least one account (or a
pre-sealed `--payload-id`).

## MCP server

```bash
npx @reqport/cli mcp
```

A stdio MCP server (official `@modelcontextprotocol/sdk`) exposing the same
operations, built on the same client. Point Claude Desktop / Claude Code at it:

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

> You are integrating our company as a **Reqport responder**. Use the `@reqport/cli`
> tool (`npx @reqport/cli`). Reqport is content-blind but the responder loop is
> **server-assisted**, so you do **not** write any encryption code — reads decrypt
> in the TEE and answers are sealed server-side.
>
> 1. I will export `REQPORT_API_KEY` (an `rqk_live_` sandbox key). Never print,
>    hardcode, or commit it. Always use `--env sandbox`; never call prod.
> 2. Run `npx @reqport/cli --env sandbox doctor` and confirm attestation + auth pass.
> 3. Run `npx @reqport/cli --env sandbox requests list` to find open requests
>    addressed to us. Sandbox is seeded by a synthetic authority
>    (`reqport-authority-test.com`); if the list is empty, tell me — do not invent data.
> 4. For a business-relationship check: `requests show <id>` to read it, then answer:
>    `respond <id> --has-relationship false --yes` (no customer → auth.002 NFOU) or
>    `respond <id> --has-relationship true --account ACCOUNT:<iban>:IBAN:<label> --yes`
>    (→ auth.002 COMP, accounts sealed in the TEE).
> 5. Verify with `requests show <id> --json` that status is `RESPONDED` with the
>    expected outcome. Use `--json` throughout for assertable output.
>
> If you prefer tool calls over shell, run `npx @reqport/cli mcp` (a stdio MCP
> server with the same operations) and configure it with `REQPORT_API_KEY` +
> `REQPORT_ENV=sandbox` in its env.

An agent skill is bundled at `.claude/skills/reqport-responder/SKILL.md`.

## Development

```bash
npm install        # also builds via prepare
npm run build      # tsc → dist/
npm run dev -- --env sandbox doctor   # run from source with tsx
```

Node >= 18. Uses the built-in global `fetch`. Exact-pinned deps: `commander`,
`@modelcontextprotocol/sdk`, `zod`.

> Not yet published to npm. Until then, run locally with `node dist/index.js …`
> or `npm link`. Publishing is gated on the maintainer's go-ahead.
