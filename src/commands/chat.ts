/**
 * `qp chat …` — the multi-org chat surface anchored to a graph node/edge.
 *
 *   qp chat create --target <kind>:<id> --participant <org> [--participant …] [--title <t>]
 *   qp chat post <chatId> --message <text>
 *   qp chat add <chatId> --org <org>
 *   qp chat show <chatId>              (metadata + decrypted messages, oldest first)
 *   qp chat list --target <kind>:<id>
 *
 * Server-assisted, like the responder loop: the server seals a per-participant
 * copy on post and returns the caller's decrypted copies on show — no client
 * crypto. Caller + participants must be parties to the target (non-party → 403,
 * naming a non-party participant → 400; surfaced via explainError).
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { parseTarget } from "../core.js";
import { line, printJson, table } from "../ui.js";
import type { ChatView } from "../types.js";

async function clientFor(env: ReqportEnv): Promise<ReqportClient> {
  return new ReqportClient({ env, credential: await requireResponderCredential() });
}

function fmtParticipants(chat: ChatView): string {
  return (chat.participants ?? []).map((p) => p.org).join(", ") || "(none)";
}

export async function runChatCreate(
  env: ReqportEnv,
  opts: { target: string; participant?: string[]; title?: string; json?: boolean }
): Promise<number> {
  const target = parseTarget(opts.target);
  const participants = opts.participant ?? [];
  if (participants.length === 0) {
    throw new Error("Pass at least one --participant <org>.");
  }
  const client = await clientFor(env);
  const chat = await client.createChat({ target, participants, title: opts.title });

  if (opts.json) {
    printJson(chat);
    return 0;
  }
  line(`Chat created ${chat.chatId}`);
  line(`  target:       ${target.kind}:${target.id}`);
  if (chat.title) line(`  title:        ${chat.title}`);
  line(`  participants: ${fmtParticipants(chat)}`);
  line("");
  line(`Post a message:  qp chat post ${chat.chatId} --message "…"`);
  return 0;
}

export async function runChatPost(
  env: ReqportEnv,
  chatId: string,
  opts: { message?: string; json?: boolean }
): Promise<number> {
  if (!opts.message) throw new Error("Pass the message text with --message <text>.");
  const client = await clientFor(env);
  const res = await client.postChatMessage(chatId, opts.message);

  if (opts.json) {
    printJson(res);
    return 0;
  }
  line(`Message posted to ${res.chatId ?? chatId}`);
  if (res.messageId) line(`  message id:            ${res.messageId}`);
  if (res.sealedParticipantCount !== undefined) {
    line(`  sealed for ${res.sealedParticipantCount} participant(s)`);
  }
  return 0;
}

export async function runChatAdd(
  env: ReqportEnv,
  chatId: string,
  opts: { org?: string; json?: boolean }
): Promise<number> {
  if (!opts.org) throw new Error("Pass the org to add with --org <org>.");
  const client = await clientFor(env);
  const chat = await client.addChatParticipant(chatId, opts.org);

  if (opts.json) {
    printJson(chat);
    return 0;
  }
  line(`Added ${opts.org} to chat ${chat.chatId}`);
  line(`  participants: ${fmtParticipants(chat)}`);
  return 0;
}

export async function runChatShow(
  env: ReqportEnv,
  chatId: string,
  opts: { json?: boolean }
): Promise<number> {
  const client = await clientFor(env);
  const detail = await client.getChat(chatId);

  if (opts.json) {
    printJson(detail);
    return 0;
  }
  const chat = detail.chat;
  line(`Chat ${chat.chatId}`);
  if (chat.target) line(`  target:       ${chat.target.kind}:${chat.target.id}`);
  if (chat.title) line(`  title:        ${chat.title}`);
  line(`  participants: ${fmtParticipants(chat)}`);
  if (chat.createdAt) line(`  created:      ${chat.createdAt}`);
  line("");
  const messages = detail.messages ?? [];
  if (messages.length === 0) {
    line("No messages yet.");
    return 0;
  }
  line(`Messages (${messages.length}, oldest first, decrypted for you):`);
  for (const m of messages) {
    const when = m.createdAt ?? "";
    line(`  [${when}] ${m.body ?? ""}`);
  }
  return 0;
}

export async function runChatList(
  env: ReqportEnv,
  opts: { target: string; json?: boolean }
): Promise<number> {
  const target = parseTarget(opts.target);
  const client = await clientFor(env);
  const chats = await client.listChats(target);

  if (opts.json) {
    printJson(chats);
    return 0;
  }
  if (!chats || chats.length === 0) {
    line(`No chats on ${target.kind}:${target.id}.`);
    return 0;
  }
  const rows = chats.map((c) => [
    c.chatId,
    c.title ?? "",
    fmtParticipants(c),
    c.createdAt ?? "",
  ]);
  line(table(["CHAT ID", "TITLE", "PARTICIPANTS", "CREATED"], rows));
  line("");
  line(`${chats.length} chat(s). Read one:  qp chat show <CHAT ID>`);
  return 0;
}
