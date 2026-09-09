#!/usr/bin/env node
/**
 * @reqport/cli — the `qp` responder CLI + MCP server.
 *
 * Auth for automation: REQPORT_API_KEY (rqk_live_...) from the environment.
 * Auth for humans: `qp login` (Signicat, browser). Key is never a flag / logged.
 * Target environment via --env sandbox|uat|prod (default sandbox / REQPORT_ENV).
 */

import { Command } from "commander";
import { resolveEnv } from "./env.js";
import { explainError, err } from "./ui.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("qp")
    .description(
      "Answer Reqport data requests (e.g. Engagemangskontroll / business-relationship checks).\n" +
        "Automation: set REQPORT_API_KEY (rqk_live_). Humans: run `qp login`, then `qp keys create`.\n" +
        "Content is decrypted server-side in the TEE — no client crypto needed."
    )
    .version(VERSION)
    .option("-e, --env <env>", "target environment: sandbox | uat | prod", process.env.REQPORT_ENV)
    .option("--json", "machine-readable JSON output", false)
    .showHelpAfterError();

  const globalEnv = () => resolveEnv(program.opts().env as string | undefined);
  const globalJson = () => Boolean(program.opts().json);

  const wrap =
    (fn: () => Promise<number>) =>
    async (): Promise<void> => {
      try {
        process.exitCode = await fn();
      } catch (e) {
        err(`Error: ${explainError(e)}`);
        process.exitCode = 1;
      }
    };

  // ── login / logout / whoami ────────────────────────────────────────────────
  program
    .command("login")
    .description("Sign in via Signicat (browser) to mint your own API keys")
    .option("--device", "use the device-code flow (headless / no local browser)", false)
    .option("--issuer <url>", "OIDC issuer (default https://login.reqport.com/auth/open or QP_ISSUER)")
    .option("--client-id <id>", "OAuth client_id (default QP_OAUTH_CLIENT_ID)")
    .option("--scope <scopes>", "OAuth scopes (default: openid profile email offline_access)")
    .action((opts) =>
      wrap(async () => {
        const { runLogin } = await import("./commands/login.js");
        return runLogin({
          device: opts.device,
          issuer: opts.issuer,
          clientId: opts.clientId,
          scope: opts.scope,
          json: globalJson(),
        });
      })()
    );

  program
    .command("logout")
    .description("Clear the stored login")
    .action(() =>
      wrap(async () => {
        const { runLogout } = await import("./commands/login.js");
        return runLogout(globalJson());
      })()
    );

  program
    .command("whoami")
    .description("Show the stored login (issuer, client, expiry)")
    .action(() =>
      wrap(async () => {
        const { runWhoami } = await import("./commands/login.js");
        return runWhoami(globalJson());
      })()
    );

  // ── requests ─────────────────────────────────────────────────────────────
  const requests = program.command("requests").description("Discover and read requests");

  requests
    .command("list")
    .description("List requests (via /v1/affordances). Default: open requests addressed to you.")
    .option("-s, --state <state>", "affordance state", "open")
    .option("-t, --type <edgeType>", "filter by workflow/edge type")
    .option("--mine", "list your org's own edges (/mine) instead of addressed-to-me", false)
    .action((opts) =>
      wrap(async () => {
        const { runList } = await import("./commands/requests.js");
        return runList(globalEnv(), {
          state: opts.state,
          type: opts.type,
          mine: opts.mine,
          json: globalJson(),
        });
      })()
    );

  requests
    .command("show <id>")
    .description("Show one request, decrypting its content in the TEE")
    .action((id) =>
      wrap(async () => {
        const { runShow } = await import("./commands/requests.js");
        return runShow(globalEnv(), id, { json: globalJson() });
      })()
    );

  // ── respond ───────────────────────────────────────────────────────────────
  program
    .command("respond <id>")
    .description("Answer a request (auto-detects business-relationship vs generic)")
    .option("--has-relationship <bool>", "business-relationship answer: true | false")
    .option("--status <status>", "generic response status: COMP | NFOU")
    .option(
      "--account <spec>",
      "disclose a typed instrument TYPE:identifier[:scheme[:label]] (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option("--note <text>", "optional free-text note (auth.002 AddtlInf)")
    .option("--free-text <text>", "generic response free-text answer")
    .option("--payload-id <uuid>", "advanced: a pre-sealed answer document payloadId")
    .option("--show", "show the request before answering (default when not --json)")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((id, opts) =>
      wrap(async () => {
        const { runRespond } = await import("./commands/respond.js");
        return runRespond(globalEnv(), id, {
          hasRelationship: opts.hasRelationship,
          status: opts.status,
          account: opts.account,
          note: opts.note,
          freeText: opts.freeText,
          payloadId: opts.payloadId,
          show: opts.show,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  // ── doctor ────────────────────────────────────────────────────────────────
  program
    .command("doctor")
    .description("Verify env wiring, attestation, and credential auth")
    .action(() =>
      wrap(async () => {
        const { runDoctor } = await import("./commands/doctor.js");
        return runDoctor(globalEnv(), globalJson());
      })()
    );

  // ── keys ──────────────────────────────────────────────────────────────────
  const keys = program
    .command("keys")
    .description("Manage API keys (create/list/revoke need `qp login`; status is read-only)")
    .action(() =>
      wrap(async () => {
        const { runKeysStatus } = await import("./commands/keys.js");
        return runKeysStatus(globalEnv(), globalJson());
      })()
    );
  keys
    .command("status")
    .description("Show the active credential and whether it authenticates")
    .action(() =>
      wrap(async () => {
        const { runKeysStatus } = await import("./commands/keys.js");
        return runKeysStatus(globalEnv(), globalJson());
      })()
    );
  keys
    .command("create")
    .description("Mint a new rqk_live_ key (requires `qp login` + ORG_ADMIN)")
    .option("-n, --name <name>", "display name for the key (required)")
    .option(
      "--scopes <csv>",
      "comma-separated scopes",
      "payloads:read,responses:write"
    )
    .option("--expires-in-days <n>", "optional expiry in days", (v) => parseInt(v, 10))
    .action((opts) =>
      wrap(async () => {
        const { runKeysCreate } = await import("./commands/keys.js");
        return runKeysCreate(globalEnv(), {
          name: opts.name,
          scopes: opts.scopes,
          expiresInDays: opts.expiresInDays,
          json: globalJson(),
        });
      })()
    );
  keys
    .command("list")
    .description("List the org's API keys (metadata only)")
    .action(() =>
      wrap(async () => {
        const { runKeysList } = await import("./commands/keys.js");
        return runKeysList(globalEnv(), globalJson());
      })()
    );
  keys
    .command("revoke <keyId>")
    .description("Revoke an API key")
    .action((keyId) =>
      wrap(async () => {
        const { runKeysRevoke } = await import("./commands/keys.js");
        return runKeysRevoke(globalEnv(), keyId, globalJson());
      })()
    );

  // ── mcp ──────────────────────────────────────────────────────────────────
  program
    .command("mcp")
    .description("Run the stdio MCP server (for Claude Desktop / Claude Code)")
    .action(() =>
      wrap(async () => {
        const { runMcpServer } = await import("./mcp/server.js");
        await runMcpServer(program.opts().env as string | undefined);
        // The MCP server runs until the transport closes; keep the process alive.
        return await new Promise<number>(() => {});
      })()
    );

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  err(`Fatal: ${explainError(e)}`);
  process.exit(1);
});
