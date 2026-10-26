// Run after `npm run build`: node test/readiness.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GUARDIAN_DIR = mkdtempSync(join(tmpdir(), "rg-"));
const { audit, savePlan, grantApproval } = await import("../dist/audit.js");
const { doReport } = await import("../dist/core.js");

const plan = (planId, risk, targetEnv) => ({ plan: { planId, risk, approvalRequired: risk !== "low", targetEnv }, diagnosis: {} });

// 1) An earlier validated promotion must NOT make a later pending one "ready".
savePlan(plan("plan-1", "low", "INT-SFP"));
audit("submitted", { planId: "plan-1", promotionId: "a17hk00000cSc9WAAS", status: "Submitted" });
audit("verified", { planId: "plan-1", promotionId: "a17hk00000cSc9W", promotion: "P00011", status: "Validated", ready: true });
assert.equal(doReport().promotionReady, true, "validated low-risk promotion is ready");
audit("submitted", { planId: "plan-1", promotionId: "a17hk00000cZZZZAAS", status: "Submitted" });
assert.equal(doReport().promotionReady, false, "newer pending promotion must not inherit readiness");

// 2) Validated production promotion is still not ready until a human approves.
savePlan(plan("plan-2", "high", "Production-SFP"));
audit("submitted", { planId: "plan-2", promotionId: "a17hk00000cPRODAAS", status: "Submitted" });
audit("verified", { planId: "plan-2", promotionId: "a17hk00000cPROD", status: "Validated", ready: true });
assert.equal(doReport().promotionReady, false, "prod promotion blocked without approval");
assert.equal(doReport().pendingApproval, true);
grantApproval("plan-2", "tester");
assert.equal(doReport().promotionReady, true, "ready after approval");

console.log("readiness tests passed");

// 3) Job lookup parsing against the shape returned by `agentia cicd work status --json`.
const { parseJobFromStatus } = await import("../dist/jobs.js");
const status = { result: { jobs: [
  { id: "a0shk000000d7ODAAY", name: "JE-031", status: "Successful", templateName: "SFDX Deploy", destinationName: "INT-SFP" },
  { id: "a0shk000000d7EXAAY", name: "JE-028", status: "Error", templateName: "SFDX Deploy", destinationName: "INT-SFP",
    errorMessage: "No such column 'Segment__c' on entity 'Account'." },
] } };
const ok = parseJobFromStatus(status, "a0shk000000d7EXAAY");
assert.equal(ok.ok, true); assert.equal(ok.destination, "INT-SFP"); assert.equal(ok.job.failedStep, "Deploy");
assert.match(ok.errorText, /Segment__c/);
assert.equal(parseJobFromStatus(status, "a0shk000000d7ODAAY").ok, false, "successful job has no error");
assert.equal(parseJobFromStatus(status, "a0shk000000zzzzAAA").ok, false, "unknown job");
console.log("job lookup tests passed");
