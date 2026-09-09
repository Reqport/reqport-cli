# @reqport/cli — `qp`

A publishable `npx` CLI (binary: **`qp`**) **and** bundled **MCP server** for
Reqport **responders** — the data-holder side. Discover the requests addressed to
your organisation, read them, and answer them (e.g. **Engagemangskontroll** /
business-relationship checks as ISO 20022 **auth.002**). Humans can also sign in
with Signicat (device flow — no callback) and mint their own API keys — no portal
round-trip.

```bash
# Automation (agents / CI): use an API key
export REQPORT_API_KEY="rqk_live_..."          # PowerShell: $env:REQPORT_API_KEY="..."
npx @reqport/cli --env sandbox doctor          # the bin is `qp`

# Humans: log in (device flow — approve on a Signicat page, no callback) and mint a key
qp login
qp keys create --env sandbox --name my-integration --scopes payloads:read,responses:write
```

> The package is `@reqport/cli`; the single binary it installs is **`qp`**, so
> `npx @reqport/cli …` and `qp …` are equivalent.

## Why it's thin (the content-blind model)

Reqport stores only ciphertext, but the **responder loop is server-assisted**, so
this CLI is just HTTP + a bearer credential — **no client-side crypto**:

| Step | Endpoint | Who decrypts / seals |
|------|----------|----------------------|
| Read a request | `POST /v1/payloads/decrypt-batch` | The **TEE** decrypts in-enclave and returns plaintext to your authorized credential |
| Answer (yes/no + accounts) | `POST /v1/requests/{id}/business-relationship-response` | The **TEE** seals the answer server-side |

No Model-1 dual-JWE, device keys, or DPoP are needed for this loop. (Uploading a
*sealed answer document* for the generic structured `/response` path is the only
flow that would require client-side encryption; it is intentionally not
implemented here.)

## Credentials — two ways to authenticate

- **API key (`rqk_live_...`)** — for automation. Read from **`REQPORT_API_KEY`**
  at runtime only; never a flag, never logged. Needs scopes **`payloads:read`** +
  **`responses:write`** for the responder loop.
- **Human login (`qp login`)** — a Signicat sign-in via the **device
  authorization grant** (the default): the CLI prints a verification URL, you
  approve on that Signicat page (email-OTP), and no redirect/callback is used.
  Used to **mint keys** (`qp keys create/list/revoke`, which require ORG_ADMIN and
  cannot be done with an API key) and, as a convenience, to run the responder
  commands when `REQPORT_API_KEY` is unset. (`--loopback` selects an auth-code +
  PKCE flow for local/dev clients that have a 127.0.0.1 redirect; not for prod.)

Precedence for `requests` / `respond`: `REQPORT_API_KEY` first, else a stored
login. **Agents/CI should always use `REQPORT_API_KEY`.**

Tokens are stored at **`%APPDATA%\qp\tokens.json`** (Windows) or
**`$XDG_CONFIG_HOME/qp/tokens.json`** → `~/.config/qp/tokens.json` (macOS/Linux),
written `0600` (best-effort on Windows). The CLI **never** sees your password —
auth happens on the Signicat page. `qp logout` clears the file.

## Environments

`--env sandbox|uat|prod` (default `sandbox`, or `REQPORT_ENV`):

- `sandbox` → `https://sandbox.reqport.com/vanta`
- `uat` → `https://vanta.dev-uat.reqport.com/vanta`
- `prod` → `https://vanta.reqport.com/vanta`

The Signicat JWT is portable across clusters (same issuer), so `qp login` once
and `qp keys create --env <any>`.

## Commands

| Command | What it does |
|---------|--------------|
| `qp login [--loopback] [--issuer] [--client-id] [--scope] [--acr]` | Sign in via Signicat (device flow by default; `--loopback` for local dev) |
| `qp logout` / `qp whoami` | Clear / show the stored login |
| `qp doctor` | Verify base URL, TEE attestation, and that your credential authenticates |
| `qp requests list [--state open] [--type <t>] [--mine]` | Discover requests via `/v1/affordances` |
| `qp requests show <id>` | Read one request; decrypts its content in the TEE |
| `qp respond <id> …` | Answer — auto-detects business-relationship vs generic |
| `qp keys status` | Show the active credential and whether it authenticates |
| `qp keys create --name <n> [--scopes csv] [--expires-in-days n]` | Mint an `rqk_live_` key (needs `qp login` + ORG_ADMIN) |
| `qp keys list` / `qp keys revoke <keyId>` | List / revoke the org's keys |
| `qp mcp` | Run the stdio MCP server |

Global flags: `--env`, `--json` (machine-readable output on every command).

### Minting a key (human)

```bash
qp login                                     # browser sign-in
qp keys create --env sandbox --name ci-bot --scopes payloads:read,responses:write
# → prints the rqk_live_ cleartext ONCE; export it as REQPORT_API_KEY
qp keys list --env sandbox
qp keys revoke --env sandbox <keyId>
```

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

## Signicat client registration (external dependency for `qp login`)

`qp login` needs a **dedicated PUBLIC, no-callback OAuth client** registered in
the **production authority tenant** `login.reqport.com/auth/open`. It must live in
that authority tenant (not UAT): Vanta validates JWTs against this issuer in both
sandbox and prod, so a UAT-tenant client's tokens would be rejected — and
repointing sandbox-Vanta at another issuer would break the WP-2 console.

The client uses the **device authorization grant** and therefore needs **no
redirect URI at all** — this deliberately sidesteps any policy against
localhost/127.0.0.1 callbacks on production clients. The tenant's discovery doc
does not yet advertise `token_endpoint_auth_method=none`, so a public client must
be added. Hand this spec to your Signicat admin:

| Field | Value |
|-------|-------|
| **Authority / tenant** | `login.reqport.com/auth/open` (production authority — **not** UAT) |
| **Client type** | **Public** (native/CLI; no client secret) |
| **`token_endpoint_auth_method`** | **`none`** |
| **Grant types** | `urn:ietf:params:oauth:grant-type:device_code`, `refresh_token` |
| **Redirect URIs** | **None** — device flow uses no callback |
| **PKCE** | `S256` (used on the loopback dev path; harmless to require) |
| **Device flow** | Enable the device authorization grant (verification URI + user code shown to the user) |
| **Scopes** | `openid profile email offline_access` (`offline_access` → refresh token) |
| **`acr_values`** | `idp:otp-email` (email-OTP, mirrors the portal login UX) |
| **Issued token audience** | Must be accepted by Vanta's `JwtDecoder` (issuer `https://login.reqport.com/auth/open`). If Vanta validates `aud`, include the Vanta audience; otherwise issuer validation suffices. |

> The CLI's `--loopback` mode (auth-code + PKCE with a 127.0.0.1 redirect) is for
> **local/dev only** and is **not** part of this production client — it would
> require a localhost callback the prod client intentionally does not have.

**Claims Vanta reads** (verified in `ReqportPrincipalAuthFilter` /
`ApiKeyController`): the user identity is the JWT **`sub`** (required), and the
email is **`email`** or, failing that, **`idp_id`** — so the token must carry
`sub` and one of `email`/`idp_id` (Signicat Email OTP returns email in both when
`profile email` scopes are requested). **Org is resolved server-side from `sub`**
(not a JWT claim). Key minting additionally requires the user to be in the
**`ORG_ADMIN`** group, which Vanta checks live via the Consortium
`identity/me` — the same JWT is forwarded there, so it must be acceptable to
Consortium too.

Once registered, point the CLI at it:

```bash
export QP_OAUTH_CLIENT_ID="<the qp client id>"
# optional: export QP_ISSUER="https://login.reqport.com/auth/open"
# optional: export QP_OAUTH_ACR="idp:otp-email"    # default; set "" to omit
# optional: export QP_JWT_SOURCE=id_token   # if Vanta expects the id_token rather than the access_token
qp login                       # device flow: prints a URL + code to approve
```

Until the client is registered, `qp login` fails fast with this guidance and the
rest of the CLI still works with `REQPORT_API_KEY`.

## MCP server

```bash
npx @reqport/cli mcp
```

A stdio MCP server (official `@modelcontextprotocol/sdk`) exposing the same
responder operations, built on the same client. **API-key-only by design** — an
agent cannot complete an interactive Signicat login, so `qp login` is human/CLI
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
>    have not given you a key, ask me to run `qp login && qp keys create --env
>    sandbox --name agent --scopes payloads:read,responses:write` and hand you the
>    cleartext, or to make one on the portal `/developer` page.)
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
