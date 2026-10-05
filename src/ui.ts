/**
 * Tiny stdout/stderr helpers. All human output goes through here so the MCP
 * server (which owns stdout for its protocol) can avoid it entirely.
 */

import { createInterface } from "node:readline/promises";
import { isArmReleaseErrorCode } from "./armSurface.js";
import { redactSecrets, ReqportApiError } from "./client.js";

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Machine envelope for a vanta error. `body` is the parsed JSON object when the
 * server sent JSON (same fields, including steer / rejectedFields / family),
 * otherwise the raw text. HTTP status is alongside the body, not a replacement.
 */
export function apiErrorEnvelope(e: ReqportApiError): {
  httpStatus: number;
  path: string;
  body: unknown;
} {
  const body = e.parsedBody !== undefined ? e.parsedBody : e.body;
  return {
    httpStatus: e.status,
    path: redactSecrets(e.path),
    body: redactValue(body),
  };
}

/**
 * Ask a yes/no question on an interactive TTY. Returns the user's answer. The
 * caller is responsible for gating (e.g. skip when --yes/--json or non-TTY).
 */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return ans === "y" || ans === "yes";
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function line(s = ""): void {
  process.stdout.write(s + "\n");
}

export function err(s: string): void {
  process.stderr.write(s + "\n");
}

/** Render a compact fixed-width table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  return [fmt(headers), sep, ...rows.map(fmt)].join("\n");
}

/**
 * Turn any thrown value into a message safe to print.
 *
 * A body that carries a stable `code` (ARM_STRUCTURED_NOT_ENABLED,
 * ARM_INFORMATION_STRUCTURED_FIELDS, ruleset reject-steer, …) is rendered as
 * HTTP status plus that JSON. It is not rewritten as a scope error or as HOLD.
 */
function contractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

export function explainError(e: unknown): string {
  if (e instanceof ReqportApiError) {
    if (e.code) {
      const envelope = apiErrorEnvelope(e);
      const json = JSON.stringify(envelope.body, null, 2);
      // ARM release-gate refusals keep the server's contract message. They are
      // never rewritten into a sealed-and-sent success.
      if (isArmReleaseErrorCode(e.code)) {
        const message = contractMessage(envelope.body) ?? e.code;
        return `${message}\nHTTP ${envelope.httpStatus}\n${json}`;
      }
      return `HTTP ${envelope.httpStatus}\n${json}`;
    }
    const hint =
      e.status === 401
        ? " — check REQPORT_API_KEY is a valid rqk_live_ key for this --env."
        : e.status === 403
          ? " — the key lacks the required scope, or your org is not a party to this request."
          : e.status === 404
            ? " — not found (wrong id or --env?)."
            : e.status === 503
              ? " — service says the operation is unavailable in this environment."
              : "";
    const body = e.body ? ` ${redactSecrets(e.body)}` : "";
    return redactSecrets(`HTTP ${e.status} on ${e.path}${hint}${body}`);
  }
  return redactSecrets(e instanceof Error ? e.message : String(e));
}

/**
 * CLI error channel. `--json` writes the vanta envelope to stdout so a machine
 * reader sees the server body. Human output stays on stderr.
 */
export function reportCliError(e: unknown, json: boolean): void {
  if (json && e instanceof ReqportApiError) {
    printJson(apiErrorEnvelope(e));
    return;
  }
  err(`Error: ${explainError(e)}`);
}
