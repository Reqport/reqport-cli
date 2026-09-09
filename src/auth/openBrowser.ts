/**
 * Best-effort "open this URL in the default browser". The CLI always prints the
 * URL too, so a failure here is non-fatal. On Windows we use rundll32 (handles
 * `&` in URLs, unlike `cmd start`).
 */

import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* non-fatal — the URL is printed for manual opening. */
  }
}
