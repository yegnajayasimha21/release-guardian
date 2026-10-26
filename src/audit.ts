import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// State lives next to the package (not the caller's cwd), so the MCP server and
// `rg approve` always agree on where approvals/plans are, wherever each is launched from.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DIR = process.env.GUARDIAN_DIR ? resolve(process.env.GUARDIAN_DIR) : join(ROOT, ".guardian");
const AUDIT = join(DIR, "audit.jsonl");
const PLANS = join(DIR, "plans.json");

function ensure() { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true }); }

export function audit(event: string, data: Record<string, unknown>) {
  ensure();
  appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n");
}

export function readAudit(): any[] {
  if (!existsSync(AUDIT)) return [];
  return readFileSync(AUDIT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Plans are persisted so they survive an MCP server restart and so `rg approve` can validate the id.
export function loadPlans(): Record<string, any> {
  if (!existsSync(PLANS)) return {};
  try { return JSON.parse(readFileSync(PLANS, "utf8")); } catch { return {}; }
}
export function savePlan(entry: { plan: { planId: string } } & Record<string, unknown>) {
  ensure();
  const all = loadPlans();
  all[entry.plan.planId] = entry;
  writeFileSync(PLANS, JSON.stringify(all, null, 2));
}
export function getPlan(planId: string): any | undefined { return loadPlans()[planId]; }

// Approvals are granted out-of-band by a human via `rg approve <planId>`.
// No MCP tool can create this file. (A coding agent with shell access could still run the CLI,
// so treat this as a human-in-the-loop control for the demo, not a hard security boundary.)
const SAFE_ID = /^[\w-]+$/;
export function approvalPath(planId: string) {
  if (!SAFE_ID.test(planId)) throw new Error("invalid planId");
  ensure();
  return join(DIR, `${planId}.approved`);
}
export function grantApproval(planId: string, by: string) {
  writeFileSync(approvalPath(planId), JSON.stringify({ by, ts: new Date().toISOString() }));
  audit("approval_granted", { planId, by });
}
export function isApproved(planId: string) { return SAFE_ID.test(planId) && existsSync(approvalPath(planId)); }
