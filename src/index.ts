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

const VERSION = "0.6.0";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("qp")
    .description(
      "Answer Reqport data requests (e.g. Engagemangskontroll / business-relationship checks).\n" +
        "Automation: set REQPORT_API_KEY (rqk_live_). Humans: run `qp login` to pair with the console.\n" +
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
    .description("Pair with the Reqport console (browser) to receive an API key — no callback, no OAuth client")
    .option("--portal-url <url>", "portal base URL (default https://reqport.com or QP_PORTAL_URL)")
    .option("--name <keyName>", "requested display name for the minted key")
    .action((opts) =>
      wrap(async () => {
        const { runLogin } = await import("./commands/login.js");
        return runLogin({
          env: globalEnv(),
          portalUrl: opts.portalUrl,
          name: opts.name,
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
    .description("Show the stored login (env, key id, scopes) — local only")
    .action(() =>
      wrap(async () => {
        const { runWhoami } = await import("./commands/login.js");
        return runWhoami(globalJson());
      })()
    );

  program
    .command("use [env]")
    .alias("env")
    .description("Switch the active env among stored logins (sandbox | uat | prod); no arg shows the current one")
    .action((env) =>
      wrap(async () => {
        const { runUse } = await import("./commands/login.js");
        return runUse(env as string | undefined, globalJson());
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
    .option(
      "--relationship-types <list>",
      "business-relationship: comma-separated relationship types (CUSTOMER, ACCOUNT_HOLDER, BENEFICIAL_OWNER, AUTHORISED_REPRESENTATIVE, COUNTERPARTY, FORMER_CUSTOMER, OTHER) — optional but recommended on a true answer"
    )
    .option("--note <text>", "optional free-text note (auth.002 AddtlInf)")
    .option("--free-text <text>", "generic response free-text answer")
    .option("--payload-id <uuid>", "advanced: a pre-sealed answer document payloadId")
    .option(
      "--statement <path>",
      "transaction-history: a camt.053-CA JSON statement file to answer with (sealed server-side)"
    )
    .option("--show", "show the request before answering (default when not --json)")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((id, opts) =>
      wrap(async () => {
        const { runRespond } = await import("./commands/respond.js");
        return runRespond(globalEnv(), id, {
          hasRelationship: opts.hasRelationship,
          status: opts.status,
          account: opts.account,
          relationshipTypes: opts.relationshipTypes,
          note: opts.note,
          freeText: opts.freeText,
          payloadId: opts.payloadId,
          statement: opts.statement,
          show: opts.show,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  // ── pending (human-in-the-loop approval queue) ─────────────────────────────
  const pending = program
    .command("pending")
    .description("Human-in-the-loop queue for held responder answers (approve / reject / withdraw)");

  pending
    .command("list")
    .description("List this org's held responses awaiting approval (GET /v1/responses/pending)")
    .action(() =>
      wrap(async () => {
        const { runPendingList } = await import("./commands/pending.js");
        return runPendingList(globalEnv(), { json: globalJson() });
      })()
    );

  pending
    .command("approve <id>")
    .description("Release a held response — seal + send happens server-side")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((id, opts) =>
      wrap(async () => {
        const { runPendingApprove } = await import("./commands/pending.js");
        return runPendingApprove(globalEnv(), id, { yes: opts.yes, json: globalJson() });
      })()
    );

  pending
    .command("reject <id>")
    .description("Reject a held response")
    .option("--reason <text>", "optional reason for the rejection")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((id, opts) =>
      wrap(async () => {
        const { runPendingReject } = await import("./commands/pending.js");
        return runPendingReject(globalEnv(), id, {
          reason: opts.reason,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  pending
    .command("withdraw <id>")
    .description("Withdraw your own held response before it is approved")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((id, opts) =>
      wrap(async () => {
        const { runPendingWithdraw } = await import("./commands/pending.js");
        return runPendingWithdraw(globalEnv(), id, { yes: opts.yes, json: globalJson() });
      })()
    );

  // ── approval-policy ────────────────────────────────────────────────────────
  const approvalPolicy = program
    .command("approval-policy")
    .description("Show / set which response types require approval before send");

  approvalPolicy
    .command("get")
    .description("Show which response types require approval (GET /v1/responses/approval-policy)")
    .action(() =>
      wrap(async () => {
        const { runApprovalPolicyGet } = await import("./commands/approvalPolicy.js");
        return runApprovalPolicyGet(globalEnv(), { json: globalJson() });
      })()
    );

  approvalPolicy
    .command("set <types>")
    .description("Set the response types that require approval — comma-separated, or the sentinel ALL")
    .action((types) =>
      wrap(async () => {
        const { runApprovalPolicySet } = await import("./commands/approvalPolicy.js");
        return runApprovalPolicySet(globalEnv(), types, { json: globalJson() });
      })()
    );

  // ── chat ────────────────────────────────────────────────────────────────
  const chat = program
    .command("chat")
    .description("Multi-org chat anchored to a graph node/edge (server-sealed, no client crypto)");

  chat
    .command("create")
    .description("Open a chat on a node/edge with one or more participant orgs")
    .requiredOption("--target <kind:id>", "target node:<uuid> or edge:<uuid>")
    .option(
      "--participant <org>",
      "a participant org (repeatable); all must be parties to the target",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option("--title <t>", "optional chat title")
    .action((opts) =>
      wrap(async () => {
        const { runChatCreate } = await import("./commands/chat.js");
        return runChatCreate(globalEnv(), {
          target: opts.target,
          participant: opts.participant,
          title: opts.title,
          json: globalJson(),
        });
      })()
    );

  chat
    .command("post <chatId>")
    .description("Post a message to a chat (sealed per participant server-side)")
    .requiredOption("--message <text>", "the message body")
    .action((chatId, opts) =>
      wrap(async () => {
        const { runChatPost } = await import("./commands/chat.js");
        return runChatPost(globalEnv(), chatId, { message: opts.message, json: globalJson() });
      })()
    );

  chat
    .command("add <chatId>")
    .description("Add a party org to an existing chat")
    .requiredOption("--org <org>", "the org to add (must be a party to the target)")
    .action((chatId, opts) =>
      wrap(async () => {
        const { runChatAdd } = await import("./commands/chat.js");
        return runChatAdd(globalEnv(), chatId, { org: opts.org, json: globalJson() });
      })()
    );

  chat
    .command("show <chatId>")
    .description("Show chat metadata + your decrypted messages (oldest first)")
    .action((chatId) =>
      wrap(async () => {
        const { runChatShow } = await import("./commands/chat.js");
        return runChatShow(globalEnv(), chatId, { json: globalJson() });
      })()
    );

  chat
    .command("list")
    .description("List chats anchored to a node/edge")
    .requiredOption("--target <kind:id>", "target node:<uuid> or edge:<uuid>")
    .action((opts) =>
      wrap(async () => {
        const { runChatList } = await import("./commands/chat.js");
        return runChatList(globalEnv(), { target: opts.target, json: globalJson() });
      })()
    );

  // ── attach ──────────────────────────────────────────────────────────────
  const attach = program
    .command("attach")
    .description("Attachments anchored to a graph node/edge (server-sealed, no client crypto)");

  attach
    .command("add")
    .description("Upload a file as an attachment (base64 JSON; MIME inferred from extension)")
    .requiredOption("--target <kind:id>", "target node:<uuid> or edge:<uuid>")
    .requiredOption("--file <path>", "path to the file to upload")
    .option(
      "--participant <org>",
      "a participant org (repeatable); all must be parties to the target",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .action((opts) =>
      wrap(async () => {
        const { runAttachAdd } = await import("./commands/attach.js");
        return runAttachAdd(globalEnv(), {
          target: opts.target,
          file: opts.file,
          participant: opts.participant,
          json: globalJson(),
        });
      })()
    );

  attach
    .command("list")
    .description("List attachments anchored to a node/edge")
    .requiredOption("--target <kind:id>", "target node:<uuid> or edge:<uuid>")
    .action((opts) =>
      wrap(async () => {
        const { runAttachList } = await import("./commands/attach.js");
        return runAttachList(globalEnv(), { target: opts.target, json: globalJson() });
      })()
    );

  attach
    .command("get <attachmentId>")
    .description("Download an attachment's raw bytes to a file")
    .requiredOption("--out <path>", "where to write the downloaded bytes")
    .action((attachmentId, opts) =>
      wrap(async () => {
        const { runAttachGet } = await import("./commands/attach.js");
        return runAttachGet(globalEnv(), attachmentId, { out: opts.out, json: globalJson() });
      })()
    );

  // ── fir (Fraud Incident Response) ──────────────────────────────────────────
  const fir = program
    .command("fir")
    .description(
      "Fraud Incident Response: a multi-message FI-to-FI fraud case (notice → response → refund → confirm)"
    );

  fir
    .command("list")
    .description("Discover FIR cases addressed to you (via /v1/affordances; no list-cases endpoint)")
    .option("-s, --state <state>", "affordance state", "open")
    .option("--mine", "list your org's own FIR edges (/mine) instead of addressed-to-me", false)
    .action((opts) =>
      wrap(async () => {
        const { runFirList } = await import("./commands/fir.js");
        return runFirList(globalEnv(), { state: opts.state, mine: opts.mine, json: globalJson() });
      })()
    );

  fir
    .command("show <firId>")
    .description("Read a FIR case (content-blind metadata) — GET /v1/fir/cases/{firId}")
    .action((firId) =>
      wrap(async () => {
        const { runFirShow } = await import("./commands/fir.js");
        return runFirShow(globalEnv(), firId, { json: globalJson() });
      })()
    );

  fir
    .command("notify")
    .description("Open a FIR case with a NOTICE (sending-bank side) — POST /v1/fir/cases")
    .option("--file <path>", "JSON file with the full body {sender, recipient, recipientOrgId, notice}")
    .option("--body <json>", "the same body inline as a JSON string")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((opts) =>
      wrap(async () => {
        const { runFirNotify } = await import("./commands/fir.js");
        return runFirNotify(globalEnv(), {
          file: opts.file,
          body: opts.body,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  fir
    .command("respond <firId>")
    .description("Answer a NOTICE with per-transaction outcomes (receiver side) — POST …/{firId}/response")
    .option(
      "--outcome <spec>",
      "per-transaction outcome <transaction_ref>:<HELD|PROCESSED|PARTIAL|NEED_INFO>[:<heldAmount>:<currency>] (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option("--note <text>", "optional free-text note")
    .option("--sender <json>", "this message's sender institution as inline JSON (else from --file)")
    .option("--recipient <json>", "this message's recipient institution as inline JSON (else from --file)")
    .option("--file <path>", "JSON file with the full body {sender, recipient, outcomes, note}")
    .option("--body <json>", "the same body inline as a JSON string")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((firId, opts) =>
      wrap(async () => {
        const { runFirRespond } = await import("./commands/fir.js");
        return runFirRespond(globalEnv(), firId, {
          file: opts.file,
          body: opts.body,
          sender: opts.sender,
          recipient: opts.recipient,
          outcome: opts.outcome,
          note: opts.note,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  fir
    .command("instruct-refund <firId>")
    .description("Instruct a refund of a held transaction (bank side) — POST …/{firId}/refund-instruction")
    .option("--transaction-ref <ref>", "the transaction to refund")
    .option("--return-to <json>", "the return account as inline JSON (an Account object)")
    .option("--return-iban <iban>", "shortcut: build return_to from an IBAN")
    .option("--return-account-type <type>", "shortcut: return_to accountType")
    .option("--return-label <label>", "shortcut: return_to label")
    .option("--reference-text <text>", "return reference text")
    .option("--verification-type <type>", "verification challenge type")
    .option("--verification-description <text>", "verification challenge description")
    .option("--confirmation-requested", "request an explicit REFUND_CONFIRMATION", false)
    .option("--sender <json>", "this message's sender institution as inline JSON (else from --file)")
    .option("--recipient <json>", "this message's recipient institution as inline JSON (else from --file)")
    .option("--file <path>", "JSON file with the full body {sender, recipient, refundInstruction}")
    .option("--body <json>", "the same body inline as a JSON string")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((firId, opts) =>
      wrap(async () => {
        const { runFirInstructRefund } = await import("./commands/fir.js");
        return runFirInstructRefund(globalEnv(), firId, {
          file: opts.file,
          body: opts.body,
          sender: opts.sender,
          recipient: opts.recipient,
          transactionRef: opts.transactionRef,
          returnTo: opts.returnTo,
          returnIban: opts.returnIban,
          returnAccountType: opts.returnAccountType,
          returnLabel: opts.returnLabel,
          referenceText: opts.referenceText,
          verificationType: opts.verificationType,
          verificationDescription: opts.verificationDescription,
          confirmationRequested: opts.confirmationRequested,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  fir
    .command("confirm-refund <firId>")
    .description("Confirm a refund executed (receiver side) — POST …/{firId}/refund-confirmation")
    .option("--payload-id <uuid>", "a pre-sealed RefundExecution payloadId (docType FIR_REFUND_JSON)")
    .option("--note <text>", "optional free-text note")
    .option("--sender <json>", "this message's sender institution as inline JSON (else from --file)")
    .option("--recipient <json>", "this message's recipient institution as inline JSON (else from --file)")
    .option("--file <path>", "JSON file with the full body {sender, recipient, payloadId, note}")
    .option("--body <json>", "the same body inline as a JSON string")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((firId, opts) =>
      wrap(async () => {
        const { runFirConfirmRefund } = await import("./commands/fir.js");
        return runFirConfirmRefund(globalEnv(), firId, {
          file: opts.file,
          body: opts.body,
          sender: opts.sender,
          recipient: opts.recipient,
          payloadId: opts.payloadId,
          note: opts.note,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  fir
    .command("identity-request <firId>")
    .description("Request the identity behind a fraud counterparty (either side) — POST …/{firId}/identity-request")
    .option("--transaction-ref <ref>", "the fraud transaction the identity is about (required)")
    .option("--about-party <party>", "whose identity: ORDER_CUSTOMER | ORIGINATOR (required)")
    .option("--legal-basis <text>", "legal basis as free-text (→ legalBasis.description)")
    .option("--legal-basis-token <token>", "legal basis: a policy/authorisation token")
    .option("--legal-basis-scheme <scheme>", "legal basis: citation scheme")
    .option("--legal-basis-reference <ref>", "legal basis: citation reference")
    .option("--payment-reference <ref>", "optional payment reference to disambiguate")
    .option(
      "--requested-attribute <attr>",
      "an identity attribute being requested (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option("--free-text <text>", "optional free-text for the request")
    .option("--sender <json>", "this message's sender institution as inline JSON (else from --file)")
    .option("--recipient <json>", "this message's recipient institution as inline JSON (else from --file)")
    .option("--file <path>", "JSON file with the full body {sender, recipient, identityRequest}")
    .option("--body <json>", "the same body inline as a JSON string")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((firId, opts) =>
      wrap(async () => {
        const { runFirIdentityRequest } = await import("./commands/fir.js");
        return runFirIdentityRequest(globalEnv(), firId, {
          file: opts.file,
          body: opts.body,
          sender: opts.sender,
          recipient: opts.recipient,
          transactionRef: opts.transactionRef,
          aboutParty: opts.aboutParty,
          legalBasis: opts.legalBasis,
          legalBasisToken: opts.legalBasisToken,
          legalBasisScheme: opts.legalBasisScheme,
          legalBasisReference: opts.legalBasisReference,
          paymentReference: opts.paymentReference,
          requestedAttribute: opts.requestedAttribute,
          freeText: opts.freeText,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  fir
    .command("identity-respond <firId>")
    .description("Return the identity behind a fraud counterparty (receiver side) — POST …/{firId}/identity-response")
    .requiredOption("--record-status <status>", "FOUND | NOT_FOUND (required)")
    .option("--transaction-ref <ref>", "the transaction the identity is about (else from --file)")
    .option("--about-party <party>", "optional: ORDER_CUSTOMER | ORIGINATOR")
    .option("--payload-id <uuid>", "a pre-sealed identity document payloadId (instead of an inline subject)")
    .option("--free-text <text>", "optional free-text for the response")
    .option("--note <text>", "optional free-text note")
    .option("--sender <json>", "this message's sender institution as inline JSON (else from --file)")
    .option("--recipient <json>", "this message's recipient institution as inline JSON (else from --file)")
    .option("--file <path>", "JSON file: the IdentityResponse or its camelCase subject {naturalPerson|legalPerson}")
    .option("--body <json>", "the same inline as a JSON string")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((firId, opts) =>
      wrap(async () => {
        const { runFirIdentityRespond } = await import("./commands/fir.js");
        return runFirIdentityRespond(globalEnv(), firId, {
          file: opts.file,
          body: opts.body,
          sender: opts.sender,
          recipient: opts.recipient,
          recordStatus: opts.recordStatus,
          transactionRef: opts.transactionRef,
          aboutParty: opts.aboutParty,
          payloadId: opts.payloadId,
          freeText: opts.freeText,
          note: opts.note,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  fir
    .command("update <firId>")
    .description("Post a lifecycle UPDATE to a FIR case (either party) — POST …/{firId}/update")
    .option(
      "--update-type <type>",
      "CORRECTION | LAW_ENFORCEMENT_REFERENCE_ADDED | ADDITIONAL_TRANSACTIONS | STATUS_CHANGE | QUESTION | ANSWER (required)"
    )
    .option(
      "--status <status>",
      "fraud status for STATUS_CHANGE: SUSPECTED | STRONG_SUSPICION | CONFIRMED | CLEARED"
    )
    .option("--law-enforcement-scheme <scheme>", "law-enforcement reference scheme (e.g. a police-case scheme)")
    .option("--law-enforcement-reference <ref>", "law-enforcement reference value (e.g. the DNR / case reference)")
    .option("--transactions <json>", "additional transactions as an inline JSON array (for ADDITIONAL_TRANSACTIONS)")
    .option("--free-text <text>", "optional free-text (e.g. the QUESTION / ANSWER body)")
    .option("--file <path>", "JSON file with the full snake_case body {update_type, …}")
    .option("--body <json>", "the same body inline as a JSON string")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((firId, opts) =>
      wrap(async () => {
        const { runFirUpdate } = await import("./commands/fir.js");
        return runFirUpdate(globalEnv(), firId, {
          file: opts.file,
          body: opts.body,
          updateType: opts.updateType,
          status: opts.status,
          lawEnforcementScheme: opts.lawEnforcementScheme,
          lawEnforcementReference: opts.lawEnforcementReference,
          transactions: opts.transactions,
          freeText: opts.freeText,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  fir
    .command("close <firId>")
    .description("Close a FIR case with a terminal reason (either party) — POST …/{firId}/close")
    .option(
      "--reason <reason>",
      "REFUNDED | NOT_RECOVERABLE | NO_MATCH | WITHDRAWN | OTHER (required)"
    )
    .option("--free-text <text>", "optional free-text closing note")
    .option("--file <path>", "JSON file with the full snake_case body {reason, free_text}")
    .option("--body <json>", "the same body inline as a JSON string")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((firId, opts) =>
      wrap(async () => {
        const { runFirClose } = await import("./commands/fir.js");
        return runFirClose(globalEnv(), firId, {
          file: opts.file,
          body: opts.body,
          reason: opts.reason,
          freeText: opts.freeText,
          yes: opts.yes,
          json: globalJson(),
        });
      })()
    );

  // ── kyc (KYC / CDD — Customer Due Diligence response) ───────────────────────
  const kyc = program
    .command("kyc")
    .description(
      "KYC / CDD: answer a Customer Due Diligence request (responder side; bodies are snake_case)"
    );

  kyc
    .command("list")
    .description("Discover KYC/CDD checks addressed to you (via /v1/affordances; no list endpoint)")
    .option("-s, --state <state>", "affordance state", "open")
    .option("--mine", "list your org's own KYC edges (/mine) instead of addressed-to-me", false)
    .action((opts) =>
      wrap(async () => {
        const { runKycList } = await import("./commands/kyc.js");
        return runKycList(globalEnv(), { state: opts.state, mine: opts.mine, json: globalJson() });
      })()
    );

  kyc
    .command("show <requestId>")
    .description("Content-blind read-back of a KYC/CDD response — GET /v1/requests/{id}/kyc-response")
    .action((requestId) =>
      wrap(async () => {
        const { runKycShow } = await import("./commands/kyc.js");
        return runKycShow(globalEnv(), requestId, { json: globalJson() });
      })()
    );

  kyc
    .command("respond <requestId>")
    .description("Answer a KYC/CDD request with the CDD record — POST /v1/requests/{id}/kyc-response")
    .requiredOption("--record-status <status>", "FOUND | NOT_FOUND (mandatory)")
    .option("--file <path>", "the CDD record as snake_case JSON in a file (the record body)")
    .option("--body <inline>", "the same CDD record as inline snake_case JSON (mutually exclusive with --file)")
    .option("--payload-id <uuid>", "a pre-sealed content-blind KYC_CDD_JSON document (required when your org gates KYC)")
    .option("--note <text>", "optional free-text note (auth.002 AddtlInf)")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action((requestId, opts) =>
      wrap(async () => {
        const { runKycRespond } = await import("./commands/kyc.js");
        return runKycRespond(globalEnv(), requestId, {
          recordStatus: opts.recordStatus,
          file: opts.file,
          body: opts.body,
          payloadId: opts.payloadId,
          note: opts.note,
          yes: opts.yes,
          jsonOut: globalJson(),
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
    .description("Show the active credential (status); key management lives in the console")
    .action(() =>
      wrap(async () => {
        const { runKeysStatus } = await import("./commands/keys.js");
        return runKeysStatus(globalEnv(), globalJson());
      })()
    );
  keys
    .command("status")
    .description("Show the active credential's metadata (local only)")
    .action(() =>
      wrap(async () => {
        const { runKeysStatus } = await import("./commands/keys.js");
        return runKeysStatus(globalEnv(), globalJson());
      })()
    );
  // create/list/revoke are console-managed under portal-pairing (the CLI holds an
  // API key, which cannot call Vanta's HUMAN-only key-management endpoints).
  for (const action of ["create", "list", "revoke"] as const) {
    keys
      .command(action)
      .description(`Manage keys in the developer console (${action} is not a CLI operation)`)
      .allowUnknownOption(true)
      .action(() =>
        wrap(async () => {
          const { runKeysConsoleGuidance } = await import("./commands/keys.js");
          return runKeysConsoleGuidance(action, globalJson());
        })()
      );
  }

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
