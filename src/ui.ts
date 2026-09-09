/**
 * Tiny stdout/stderr helpers. All human output goes through here so the MCP
 * server (which owns stdout for its protocol) can avoid it entirely.
 */

import { ReqportApiError } from "./client.js";

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

/** Turn any thrown value into a friendly, actionable message. */
export function explainError(e: unknown): string {
  if (e instanceof ReqportApiError) {
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
    const body = e.body ? ` ${e.body}` : "";
    return `HTTP ${e.status} on ${e.path}${hint}${body}`;
  }
  return e instanceof Error ? e.message : String(e);
}
