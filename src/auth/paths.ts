/**
 * OS-appropriate config directory for the qp CLI.
 *   Windows: %APPDATA%\qp
 *   macOS/Linux: $XDG_CONFIG_HOME/qp or ~/.config/qp
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  if (process.env.QP_CONFIG_DIR && process.env.QP_CONFIG_DIR.trim() !== "") {
    return process.env.QP_CONFIG_DIR.trim();
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData && appData.trim() !== "") return join(appData, "qp");
    return join(homedir(), ".config", "qp");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
  return join(base, "qp");
}

export function tokensPath(): string {
  return join(configDir(), "tokens.json");
}
