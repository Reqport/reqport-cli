/**
 * `reqport mcp` — a stdio MCP server exposing the responder loop as tools, so
 * Claude Desktop / Claude Code can drive a Reqport responder integration.
 *
 * Built on the SAME ReqportClient + core logic as the CLI. The API key comes
 * from REQPORT_API_KEY in the server process's environment (configure it in the
 * MCP server definition's `env`). stdout is reserved for the MCP protocol — all
 * diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ReqportClient } from "../client.js";
import { readApiKey, resolveEnv, type ReqportEnv } from "../env.js";
import {
  decodePayloads,
  parseAccountArg,
  performRespond,
  readRequest,
} from "../core.js";
import { explainError } from "../ui.js";
import type { AccountInstrument } from "../types.js";

const VERSION = "0.1.0";

const envSchema = z
  .enum(["sandbox", "uat", "prod"])
  .optional()
  .describe("Target environment. Defaults to REQPORT_ENV or sandbox.");

const accountSchema = z
  .object({
    instrumentType: z.enum(["ACCOUNT", "WALLET", "CARD"]),
    identifier: z.string(),
    scheme: z.string().optional(),
    label: z.string().optional(),
  })
  .describe("A typed instrument disclosed with a substantive answer.");

/**
 * The MCP server is API-key-only by design: an agent cannot complete an
 * interactive browser login, so `qp login` is a human/CLI-only concern. Set
 * REQPORT_API_KEY in the MCP server's env.
 */
function clientFor(env?: string): ReqportClient {
  const resolved: ReqportEnv = resolveEnv(env);
  const key = readApiKey();
  return new ReqportClient({
    env: resolved,
    credential: key ? { value: key, kind: "apikey" } : undefined,
  });
}

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
function fail(e: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: explainError(e) }],
  };
}

export async function runMcpServer(defaultEnv?: string): Promise<void> {
  const server = new McpServer({ name: "reqport", version: VERSION });

  server.registerTool(
    "reqport_doctor",
    {
      title: "Reqport doctor",
      description:
        "Check environment wiring: base URL, TEE attestation (public), and whether the API key authenticates. Run this first.",
      inputSchema: { env: envSchema },
    },
    async ({ env }) => {
      try {
        const client = clientFor(env ?? defaultEnv);
        const report: Record<string, unknown> = { env: client.env, baseUrl: client.baseUrl };
        try {
          const att = await client.attestation();
          report.attestation = { ok: true, hasToken: Boolean(att.maaToken || att.token) };
        } catch (e) {
          report.attestation = { ok: false, detail: explainError(e) };
        }
        if (readApiKey()) {
          try {
            const aff = await client.listAffordances({ state: "open" });
            report.auth = { ok: true, openAffordances: aff.total };
          } catch (e) {
            report.auth = { ok: false, detail: explainError(e) };
          }
        } else {
          report.auth = { ok: false, detail: "REQPORT_API_KEY not set in server env." };
        }
        return ok(report);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_list_requests",
    {
      title: "List responder requests",
      description:
        "Discover requests via GET /v1/affordances. By default lists OPEN traversals addressed to your org (things to answer). Set mine=true for your org's own edges. Structure only — no content.",
      inputSchema: {
        env: envSchema,
        state: z.string().optional().describe("Affordance state (default open)."),
        edgeType: z.string().optional().describe("Filter by edge/workflow type."),
        mine: z.boolean().optional().describe("List owned edges (/mine) instead of addressed-to-me."),
      },
    },
    async ({ env, state, edgeType, mine }) => {
      try {
        const res = await clientFor(env ?? defaultEnv).listAffordances({
          state: state ?? "open",
          edgeType,
          mine,
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_show_request",
    {
      title: "Show a request (decrypted)",
      description:
        "Read one request: workflow metadata + the request payload decrypted server-side in the TEE (server-assisted, no client crypto).",
      inputSchema: { env: envSchema, id: z.string().describe("Workflow/request id.") },
    },
    async ({ env, id }) => {
      try {
        return ok(await readRequest(clientFor(env ?? defaultEnv), id));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_decrypt_payloads",
    {
      title: "Decrypt payloads",
      description:
        "Server-assisted decrypt of up to 20 payloadIds via POST /v1/payloads/decrypt-batch. Returns base64 plaintext decoded to text/JSON.",
      inputSchema: {
        env: envSchema,
        payloadIds: z.array(z.string()).min(1).max(20),
      },
    },
    async ({ env, payloadIds }) => {
      try {
        return ok(await decodePayloads(clientFor(env ?? defaultEnv), payloadIds));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_respond_business_relationship",
    {
      title: "Answer a business-relationship check",
      description:
        "Answer an Engagemangskontroll. hasRelationship=false → auth.002 NFOU (no data). true → auth.002 COMP; disclose accounts (sealed server-side in the TEE) and/or a pre-sealed payloadId.",
      inputSchema: {
        env: envSchema,
        id: z.string().describe("Request id."),
        hasRelationship: z.boolean(),
        accounts: z.array(accountSchema).optional(),
        note: z.string().optional(),
        payloadId: z.string().optional().describe("A pre-sealed BUSINESS_RELATIONSHIP_JSON answer document."),
      },
    },
    async ({ env, id, hasRelationship, accounts, note, payloadId }) => {
      try {
        const outcome = await performRespond(clientFor(env ?? defaultEnv), id, {
          hasRelationship,
          accounts: accounts as AccountInstrument[] | undefined,
          note,
          payloadId,
        });
        return ok(outcome);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_respond",
    {
      title: "Answer a generic request",
      description:
        "Submit a generic responder answer via POST /v1/requests/{id}/response. status COMP or NFOU; optional freeText, disclosed accounts, or a pre-sealed payloadId (structured item).",
      inputSchema: {
        env: envSchema,
        id: z.string(),
        status: z.enum(["COMP", "NFOU"]),
        freeText: z.string().optional(),
        accounts: z.array(accountSchema).optional(),
        note: z.string().optional(),
        payloadId: z.string().optional(),
      },
    },
    async ({ env, id, status, freeText, accounts, note, payloadId }) => {
      try {
        const outcome = await performRespond(clientFor(env ?? defaultEnv), id, {
          status,
          freeText,
          accounts: accounts as AccountInstrument[] | undefined,
          note,
          payloadId,
        });
        return ok(outcome);
      } catch (e) {
        return fail(e);
      }
    }
  );

  // Keep parseAccountArg referenced for parity with the CLI string form; MCP
  // callers pass structured accounts, but tools may also accept the string
  // shorthand in future. (No-op guard to avoid an unused import.)
  void parseAccountArg;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `reqport MCP server ready (stdio). env default=${resolveEnv(defaultEnv)}, key=${readApiKey() ? "present" : "MISSING"}.\n`
  );
}
