/**
 * `qp attach …` — attachments anchored to a graph node/edge.
 *
 *   qp attach add  --target <kind>:<id> --file <path> [--participant <org> …]
 *   qp attach list --target <kind>:<id>
 *   qp attach get  <attachmentId> --out <path>
 *
 * Upload reads the file, base64-encodes it, infers a MIME type from the
 * extension, and POSTs JSON — the server seals it (no client crypto). Download
 * returns RAW BYTES (not JSON), so it uses the client's byte variant and writes
 * them to --out. Caller + participants must be parties to the target (non-party
 * → 403, naming a non-party participant → 400; surfaced via explainError).
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { mimeTypeForFilename, parseTarget } from "../core.js";
import { line, printJson, table } from "../ui.js";

async function clientFor(env: ReqportEnv): Promise<ReqportClient> {
  return new ReqportClient({ env, credential: await requireResponderCredential() });
}

export async function runAttachAdd(
  env: ReqportEnv,
  opts: { target: string; file?: string; participant?: string[]; json?: boolean }
): Promise<number> {
  const target = parseTarget(opts.target);
  if (!opts.file) throw new Error("Pass the file to upload with --file <path>.");

  let bytes: Buffer;
  try {
    bytes = await readFile(opts.file);
  } catch (e) {
    throw new Error(`Cannot read --file "${opts.file}": ${(e as Error).message}`);
  }
  const filename = basename(opts.file);
  const mimeType = mimeTypeForFilename(filename);

  const client = await clientFor(env);
  const view = await client.createAttachment({
    target,
    filename,
    mimeType,
    contentBase64: bytes.toString("base64"),
    participants: opts.participant,
  });

  if (opts.json) {
    printJson(view);
    return 0;
  }
  line(`Attachment uploaded ${view.attachmentId}`);
  line(`  target:   ${target.kind}:${target.id}`);
  line(`  filename: ${view.filename ?? filename}`);
  line(`  mimeType: ${view.mimeType ?? mimeType}`);
  if (view.size !== undefined) line(`  size:     ${view.size} bytes`);
  if (view.participantCount !== undefined) {
    line(`  sealed for ${view.participantCount} participant(s)`);
  }
  line("");
  line(`Download it:  qp attach get ${view.attachmentId} --out ./${view.filename ?? filename}`);
  return 0;
}

export async function runAttachList(
  env: ReqportEnv,
  opts: { target: string; json?: boolean }
): Promise<number> {
  const target = parseTarget(opts.target);
  const client = await clientFor(env);
  const items = await client.listAttachments(target);

  if (opts.json) {
    printJson(items);
    return 0;
  }
  if (!items || items.length === 0) {
    line(`No attachments on ${target.kind}:${target.id}.`);
    return 0;
  }
  const rows = items.map((a) => [
    a.attachmentId,
    a.filename ?? "",
    a.mimeType ?? "",
    a.size !== undefined ? String(a.size) : "",
    a.createdAt ?? "",
  ]);
  line(table(["ATTACHMENT ID", "FILENAME", "MIME", "SIZE", "CREATED"], rows));
  line("");
  line(`${items.length} attachment(s). Download one:  qp attach get <ATTACHMENT ID> --out <path>`);
  return 0;
}

export async function runAttachGet(
  env: ReqportEnv,
  attachmentId: string,
  opts: { out?: string; json?: boolean }
): Promise<number> {
  if (!opts.out) throw new Error("Pass the output path with --out <path>.");
  const client = await clientFor(env);
  const dl = await client.downloadAttachment(attachmentId);

  try {
    await writeFile(opts.out, dl.bytes);
  } catch (e) {
    throw new Error(`Cannot write --out "${opts.out}": ${(e as Error).message}`);
  }

  if (opts.json) {
    printJson({
      attachmentId,
      out: opts.out,
      bytes: dl.bytes.length,
      contentType: dl.contentType,
      filename: dl.filename,
    });
    return 0;
  }
  line(`Downloaded ${dl.bytes.length} bytes → ${opts.out}`);
  if (dl.contentType) line(`  content-type: ${dl.contentType}`);
  if (dl.filename) line(`  server filename: ${dl.filename}`);
  return 0;
}
