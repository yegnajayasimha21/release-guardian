#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { doDiagnose, doDiagnoseJob, doRemediate, doRemediateCopado, doReport, doVerify } from "./core.js";

const server = new McpServer({ name: "release-guardian", version: "0.2.0" });
const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });

server.tool("rg_diagnose",
  "Classify a failed Salesforce deployment/test log and return a risk-scored remediation plan. Read-only.",
  { log: z.string().describe("Raw deployment or test failure log"),
    targetEnv: z.string().describe("Environment name, e.g. INT-SFP or Production-SFP"),
    destructive: z.boolean().optional() },
  async ({ log, targetEnv, destructive }) => text(doDiagnose(log, targetEnv, destructive ?? false)));

server.tool("rg_diagnose_job",
  "Diagnose a failed Copado job (or promotion) and return a risk-scored plan. The target environment is taken from Copado when available; targetEnv can only make the plan stricter. Read-only.",
  { jobId: z.string().describe("Copado job execution id, e.g. a0sh..."),
    story: z.string().optional().describe("Work item the job belongs to, e.g. US-0000029; defaults to the last work item set"),
    targetEnv: z.string().optional(),
    promotionId: z.string().optional().describe("Alternative source: read the error and destination from this promotion"),
    log: z.string().optional().describe("Raw error text, if already available"),
    destructive: z.boolean().optional() },
  async (a) => text(doDiagnoseJob(a)));

server.tool("rg_remediate",
  "Local path: optionally apply a unified-diff patch on a guardian/* branch, then run targeted Apex tests or validate against the plan's target org alias. Medium/high-risk plans are blocked until a human approves out-of-band.",
  { planId: z.string(), projectDir: z.string(), branch: z.string().optional(),
    patch: z.string().optional().describe("Unified diff"), dryRun: z.boolean().optional() },
  async (a) => text(doRemediate(a)));

server.tool("rg_remediate_copado",
  "Copado path: write files on the story's feature branch, commit, publish and submit through the Agentia CLI. The target comes from the plan. Medium/high-risk plans are blocked until a human approves out-of-band. If this call times out, do NOT call it again: use rg_report to find the promotionId.",
  { planId: z.string(), story: z.string().describe("Work item, e.g. US-0000029"),
    files: z.array(z.object({ path: z.string().describe("Relative path under force-app/"), content: z.string() })).min(1),
    projectDir: z.string().optional().describe("sfdx repo; defaults to RG_PROJECT_DIR"),
    branch: z.string().optional().describe("defaults to feature/<story>") },
  async (a) => text(doRemediateCopado(a)));

server.tool("rg_verify",
  "Check a Copado promotion. promotionReady is true only if this promotion is Validated, deployed successfully, on the planned target, and any required approval was granted.",
  { promotionId: z.string() },
  async ({ promotionId }) => text(doVerify(promotionId)));

server.tool("rg_report",
  "Return the audit trail and per-promotion readiness for a plan (or all plans).",
  { planId: z.string().optional() },
  async ({ planId }) => text(doReport(planId)));

await server.connect(new StdioServerTransport());
