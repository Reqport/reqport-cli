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

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { ReqportClient } from "../client.js";
import { readApiKey, resolveEnv, type ReqportEnv } from "../env.js";
import {
  decodePayloads,
  mimeTypeForFilename,
  parseAccountArg,
  parseTarget,
  performRespond,
  readRequest,
} from "../core.js";
import { explainError } from "../ui.js";
import { RELATIONSHIP_TYPES, type AccountInstrument, type RelationshipType } from "../types.js";

const VERSION = "0.3.0";

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

const relationshipTypesSchema = z
  .array(z.enum(RELATIONSHIP_TYPES))
  .optional()
  .describe(
    "Optional relationship-type tags for a true business-relationship answer " +
      "(ignored when hasRelationship is false). Recommended: enables a targeted follow-up (data minimisation)."
  );

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
        relationshipTypes: relationshipTypesSchema,
        note: z.string().optional(),
        payloadId: z.string().optional().describe("A pre-sealed BUSINESS_RELATIONSHIP_JSON answer document."),
      },
    },
    async ({ env, id, hasRelationship, accounts, relationshipTypes, note, payloadId }) => {
      try {
        const outcome = await performRespond(clientFor(env ?? defaultEnv), id, {
          hasRelationship,
          accounts: accounts as AccountInstrument[] | undefined,
          relationshipTypes: relationshipTypes as RelationshipType[] | undefined,
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
    "reqport_respond_transaction_history",
    {
      title: "Answer a crypto transaction-history request",
      description:
        "Answer a TRANSACTION_HISTORY_CHECK with a camt.053-CA Crypto-Asset Statement. Pass the full statement as a JSON object; Vanta validates it against the CAMT053_CA_JSON schema and seals it server-side in the TEE (no client crypto).",
      inputSchema: {
        env: envSchema,
        id: z.string().describe("Request id."),
        statement: z
          .record(z.string(), z.unknown())
          .describe("A camt.053-CA/v0.1 statement object (profile, statementId, period, responder, account, balances, entries)."),
        note: z.string().optional(),
      },
    },
    async ({ env, id, statement, note }) => {
      try {
        const outcome = await performRespond(clientFor(env ?? defaultEnv), id, {
          statement,
          note,
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

  // ── Multi-org chat ─────────────────────────────────────────────────────────

  const targetSchema = z
    .string()
    .describe('Target as "<kind>:<id>", kind ∈ {node, edge} (e.g. "node:<uuid>").');

  server.registerTool(
    "reqport_chat_create",
    {
      title: "Create a chat",
      description:
        "Open a multi-org chat anchored to a graph node/edge via POST /v1/chats. Caller and every participant must be PARTIES to the target (non-party caller → 403, non-party participant → 400). Server-sealed, no client crypto.",
      inputSchema: {
        env: envSchema,
        target: targetSchema,
        participants: z.array(z.string()).min(1).describe("Participant org ids."),
        title: z.string().optional(),
      },
    },
    async ({ env, target, participants, title }) => {
      try {
        const chat = await clientFor(env ?? defaultEnv).createChat({
          target: parseTarget(target),
          participants,
          title,
        });
        return ok(chat);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_chat_post",
    {
      title: "Post a chat message",
      description:
        "Post a message to a chat via POST /v1/chats/{id}/messages. The server seals a copy per participant (no client crypto).",
      inputSchema: {
        env: envSchema,
        chatId: z.string(),
        body: z.string().describe("The message text."),
      },
    },
    async ({ env, chatId, body }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).postChatMessage(chatId, body));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_chat_add",
    {
      title: "Add a chat participant",
      description:
        "Add a party org to an existing chat via POST /v1/chats/{id}/participants. The org must be a party to the target (non-party → 400).",
      inputSchema: {
        env: envSchema,
        chatId: z.string(),
        org: z.string().describe("The org id to add."),
      },
    },
    async ({ env, chatId, org }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).addChatParticipant(chatId, org));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_chat_show",
    {
      title: "Show a chat",
      description:
        "Read a chat via GET /v1/chats/{id}: metadata + the caller's decrypted message copies (oldest first).",
      inputSchema: { env: envSchema, chatId: z.string() },
    },
    async ({ env, chatId }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).getChat(chatId));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_chat_list",
    {
      title: "List chats",
      description: "List chats anchored to a node/edge via GET /v1/chats?target=<kind>:<id>.",
      inputSchema: { env: envSchema, target: targetSchema },
    },
    async ({ env, target }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).listChats(parseTarget(target)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── Attachments ────────────────────────────────────────────────────────────

  server.registerTool(
    "reqport_attach_add",
    {
      title: "Upload an attachment",
      description:
        "Upload an attachment to a node/edge via POST /v1/attachments. Provide either a local file path (read + base64-encoded here) or contentBase64 directly. MIME type is inferred from the filename when not given. Server-sealed, no client crypto. Caller + participants must be parties to the target.",
      inputSchema: {
        env: envSchema,
        target: targetSchema,
        file: z.string().optional().describe("Local file path to read and upload."),
        contentBase64: z.string().optional().describe("Base64 content, if not passing a file path."),
        filename: z.string().optional(),
        mimeType: z.string().optional(),
        participants: z.array(z.string()).optional(),
      },
    },
    async ({ env, target, file, contentBase64, filename, mimeType, participants }) => {
      try {
        let base64 = contentBase64;
        let name = filename;
        if (file) {
          const bytes = await readFile(file);
          base64 = bytes.toString("base64");
          if (!name) name = basename(file);
        }
        if (!base64) {
          throw new Error("Provide either a file path or contentBase64.");
        }
        const view = await clientFor(env ?? defaultEnv).createAttachment({
          target: parseTarget(target),
          filename: name,
          mimeType: mimeType ?? (name ? mimeTypeForFilename(name) : undefined),
          contentBase64: base64,
          participants,
        });
        return ok(view);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_attach_list",
    {
      title: "List attachments",
      description:
        "List attachments anchored to a node/edge via GET /v1/attachments?target=<kind>:<id>.",
      inputSchema: { env: envSchema, target: targetSchema },
    },
    async ({ env, target }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).listAttachments(parseTarget(target)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_attach_get",
    {
      title: "Download an attachment",
      description:
        "Download an attachment's raw bytes via GET /v1/attachments/{id}/download and write them to a local path (`out`). Returns the byte count, content-type, and server filename.",
      inputSchema: {
        env: envSchema,
        attachmentId: z.string(),
        out: z.string().describe("Local path to write the downloaded bytes to."),
      },
    },
    async ({ env, attachmentId, out }) => {
      try {
        const dl = await clientFor(env ?? defaultEnv).downloadAttachment(attachmentId);
        await writeFile(out, dl.bytes);
        return ok({
          attachmentId,
          out,
          bytes: dl.bytes.length,
          contentType: dl.contentType,
          filename: dl.filename,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── Pending-approval (human-in-the-loop) ───────────────────────────────────

  server.registerTool(
    "reqport_pending_list",
    {
      title: "List held responses",
      description:
        "List this org's responses held for approval via GET /v1/responses/pending (scope responses:read). Returns id, requestId, responseType, auth002Status, submitter, createdAt.",
      inputSchema: { env: envSchema },
    },
    async ({ env }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).listPendingResponses());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_pending_approve",
    {
      title: "Approve a held response",
      description:
        "Release a held response via POST /v1/responses/pending/{id}/approve (scope responses:write). The seal + send happens server-side. Irreversible.",
      inputSchema: { env: envSchema, id: z.string().describe("Pending response id.") },
    },
    async ({ env, id }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).approvePendingResponse(id));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_pending_reject",
    {
      title: "Reject a held response",
      description:
        "Reject a held response via POST /v1/responses/pending/{id}/reject (scope responses:write), optionally with a reason.",
      inputSchema: {
        env: envSchema,
        id: z.string().describe("Pending response id."),
        reason: z.string().optional(),
      },
    },
    async ({ env, id, reason }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).rejectPendingResponse(id, reason));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_pending_withdraw",
    {
      title: "Withdraw a held response",
      description:
        "Withdraw your own held response before it is approved via POST /v1/responses/pending/{id}/withdraw (scope responses:write).",
      inputSchema: { env: envSchema, id: z.string().describe("Pending response id.") },
    },
    async ({ env, id }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).withdrawPendingResponse(id));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── Approval policy ─────────────────────────────────────────────────────────

  server.registerTool(
    "reqport_approval_policy_get",
    {
      title: "Get the approval policy",
      description:
        "Show which response types require approval before send via GET /v1/responses/approval-policy (scope responses:read).",
      inputSchema: { env: envSchema },
    },
    async ({ env }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).getApprovalPolicy());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reqport_approval_policy_set",
    {
      title: "Set the approval policy",
      description:
        "Set the response types that require approval via PUT /v1/responses/approval-policy (scope responses:write). Pass the sentinel [\"ALL\"] for every type, or [] for none.",
      inputSchema: {
        env: envSchema,
        responseTypes: z
          .array(z.string())
          .describe('Response types requiring approval, or ["ALL"] for every type, or [] for none.'),
      },
    },
    async ({ env, responseTypes }) => {
      try {
        return ok(await clientFor(env ?? defaultEnv).setApprovalPolicy(responseTypes));
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
