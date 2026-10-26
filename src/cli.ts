#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { doDiagnose, doReport } from "./core.js";
import { getPlan, grantApproval, loadPlans, DIR } from "./audit.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const who = process.env.USERNAME ?? process.env.USER ?? "human"; // USERNAME on Windows

switch (cmd) {
  case "diagnose": {
    const file = flag("log"); const env = flag("env") ?? "INT-SFP";
    if (!file) { console.error("usage: rg diagnose --log <file> [--env INT-SFP]"); process.exit(2); }
    console.log(JSON.stringify(doDiagnose(readFileSync(file, "utf8"), env), null, 2)); break;
  }
  case "plans": {
    for (const { plan, diagnosis } of Object.values(loadPlans()) as any[])
      console.log(`${plan.planId}  ${plan.risk.padEnd(6)} ${plan.targetEnv}  ${diagnosis.type}`);
    break;
  }
  case "approve": {
    const id = rest[0]; if (!id) { console.error("usage: rg approve <planId>"); process.exit(2); }
    const entry = getPlan(id);
    if (!entry) { console.error(`Unknown plan ${id} (state dir: ${DIR}). Run \`rg plans\` to list plans.`); process.exit(1); }
    console.log(`Plan ${id}: ${entry.plan.risk} risk -> ${entry.plan.targetEnv}\n  ${entry.diagnosis.type}: ${entry.diagnosis.evidence[0] ?? ""}`);
    grantApproval(id, who); console.log(`Approved ${id}`); break;
  }
  case "report": console.log(doReport(rest[0]).markdown); break;
  default: console.log("rg diagnose --log f [--env E] | rg plans | rg approve <planId> | rg report [planId]");
}
