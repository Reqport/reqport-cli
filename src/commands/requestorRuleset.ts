/**
 * `qp requestor-ruleset …` — a responder org's ordered auto-approve / hold / decline
 * rules keyed on the REQUESTOR's verifiable status (GET/PUT /v1/responses/requestor-ruleset).
 * Rules are evaluated in order; the FIRST matching predicate wins. No match falls back to the
 * per-type approval policy (`qp approval-policy`). Check a requestor's status with `qp org-states`.
 *
 *   qp requestor-ruleset get
 *   qp requestor-ruleset add --action AUTO_RELEASE --authority --country SE --regulatory-class law_enforcement
 *   qp requestor-ruleset add --action HOLD_FOR_APPROVAL            # trailing catch-all: hold everything else
 *   qp requestor-ruleset set '<json rules array>'                  # replace the whole ruleset
 *   qp requestor-ruleset clear                                     # remove all rules
 */

import { ReqportClient } from "../client.js";
import { type ReqportEnv } from "../env.js";
import { requireResponderCredential } from "../auth/session.js";
import { line, printJson } from "../ui.js";
import type { RequestorRuleset, RulesetAction, RulesetPredicate, RulesetRule } from "../types.js";

const ACTIONS: RulesetAction[] = ["AUTO_RELEASE", "HOLD_FOR_APPROVAL", "DECLINE"];

async function clientFor(env: ReqportEnv): Promise<ReqportClient> {
  return new ReqportClient({ env, credential: await requireResponderCredential() });
}

function describePredicate(p: RulesetPredicate): string {
  const parts: string[] = [];
  if (p.isAuthority != null) parts.push(`authority=${p.isAuthority}`);
  if (p.isRegulatedFi != null) parts.push(`regulatedFi=${p.isRegulatedFi}`);
  if (p.country) parts.push(`country=${p.country}`);
  if (p.regulatoryClass) parts.push(`regulatoryClass=${p.regulatoryClass}`);
  if (p.regulatoryClasses?.length) parts.push(`regulatoryClasses=${p.regulatoryClasses.join("|")}`);
  return parts.length ? parts.join(", ") : "{} (any requestor — catch-all)";
}

function renderRuleset(rs: RequestorRuleset): void {
  const rules = rs.rules ?? [];
  if (rules.length === 0) {
    line("Requestor ruleset: empty — every request falls back to the per-type approval policy.");
    return;
  }
  line("Requestor ruleset (first matching rule wins):");
  rules.forEach((r, i) => {
    line(`  ${r.ordinal ?? i + 1}. IF ${describePredicate(r.predicate)}  →  ${r.action}`);
  });
  line("  (no match → per-type approval policy; see `qp approval-policy`)");
}

export async function runRequestorRulesetGet(env: ReqportEnv, opts: { json?: boolean }): Promise<number> {
  const rs = await (await clientFor(env)).getRequestorRuleset();
  if (opts.json) { printJson(rs); return 0; }
  renderRuleset(rs);
  return 0;
}

function normalizeAction(a: string | undefined): RulesetAction {
  const v = (a ?? "").trim().toUpperCase().replace(/-/g, "_");
  if (!ACTIONS.includes(v as RulesetAction)) {
    throw new Error(`--action must be one of: ${ACTIONS.join(", ")}`);
  }
  return v as RulesetAction;
}

/** Coerce a parsed JSON value into a rules array, accepting either [...] or {rules:[...]}. */
function coerceRules(parsed: unknown): RulesetRule[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { rules?: unknown }).rules)
      ? (parsed as { rules: unknown[] }).rules
      : null;
  if (!arr) throw new Error("Expected a JSON array of rules, or an object { rules: [...] }.");
  return arr.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`Rule ${i + 1} is not an object.`);
    const r = raw as { predicate?: unknown; action?: unknown };
    const action = normalizeAction(typeof r.action === "string" ? r.action : undefined);
    const predicate = (r.predicate && typeof r.predicate === "object" ? r.predicate : {}) as RulesetPredicate;
    return { predicate, action };
  });
}

export async function runRequestorRulesetSet(
  env: ReqportEnv,
  json: string,
  opts: { json?: boolean }
): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid JSON. Pass a rules array, e.g. '[{\"predicate\":{\"isAuthority\":true,\"country\":\"SE\"},\"action\":\"AUTO_RELEASE\"}]'");
  }
  const rules = coerceRules(parsed);
  const rs = await (await clientFor(env)).setRequestorRuleset(rules);
  if (opts.json) { printJson(rs); return 0; }
  line(`Ruleset updated (${rules.length} rule${rules.length === 1 ? "" : "s"}).`);
  renderRuleset(rs);
  return 0;
}

export async function runRequestorRulesetClear(env: ReqportEnv, opts: { json?: boolean }): Promise<number> {
  const rs = await (await clientFor(env)).setRequestorRuleset([]);
  if (opts.json) { printJson(rs); return 0; }
  line("Ruleset cleared — every request now falls back to the per-type approval policy.");
  return 0;
}

/**
 * Append one rule (built from flags) to the END of the current ruleset. Since the PUT replaces the
 * whole ordered set, this reads the current rules, appends, and writes them back — so the new rule is
 * evaluated LAST (useful for a trailing catch-all; put specific auto-approves before a broad hold).
 */
export async function runRequestorRulesetAdd(
  env: ReqportEnv,
  opts: {
    action?: string;
    authority?: boolean;
    notAuthority?: boolean;
    regulatedFi?: boolean;
    country?: string;
    regulatoryClass?: string;
    regulatoryClasses?: string;
    json?: boolean;
  }
): Promise<number> {
  const action = normalizeAction(opts.action);
  const predicate: RulesetPredicate = {};
  if (opts.authority) predicate.isAuthority = true;
  if (opts.notAuthority) predicate.isAuthority = false;
  if (opts.regulatedFi) predicate.isRegulatedFi = true;
  if (opts.country) predicate.country = opts.country.trim().toUpperCase();
  if (opts.regulatoryClass) predicate.regulatoryClass = opts.regulatoryClass.trim();
  if (opts.regulatoryClasses) {
    predicate.regulatoryClasses = opts.regulatoryClasses.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const client = await clientFor(env);
  const current = await client.getRequestorRuleset();
  const next: RulesetRule[] = [...(current.rules ?? []).map((r) => ({ predicate: r.predicate, action: r.action })),
    { predicate, action }];
  const rs = await client.setRequestorRuleset(next);
  if (opts.json) { printJson(rs); return 0; }
  line(`Appended rule: IF ${describePredicate(predicate)}  →  ${action}`);
  renderRuleset(rs);
  return 0;
}
