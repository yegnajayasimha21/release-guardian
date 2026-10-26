import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { diagnose, Diagnosis } from "./classifier.js";
import { isProd, makePlan, Plan } from "./planner.js";
import { audit, getPlan, isApproved, readAudit, savePlan } from "./audit.js";
import { agentia, run, runApexTests, validateDeploy } from "./exec.js";
import { isFailed, isValidated, key15, promotionGet, sameEnv } from "./copado.js";
import { fetchJob } from "./jobs.js";

function register(plan: Plan, diagnosis: Diagnosis) {
  savePlan({ plan, diagnosis });
  audit("diagnosed", { planId: plan.planId, type: diagnosis.type, evidence: diagnosis.evidence, risk: plan.risk, targetEnv: plan.targetEnv });
}

// ---------- diagnose ----------
export function doDiagnose(log: string, targetEnv: string, destructive = false) {
  const diagnosis = diagnose(log);
  const plan = makePlan(diagnosis, targetEnv, destructive);
  register(plan, diagnosis);
  return { diagnosis, plan };
}

export interface DiagnoseJobArgs { jobId: string; story?: string; targetEnv?: string; log?: string; promotionId?: string; destructive?: boolean }

// The environment that drives the risk gate comes from Copado when we can read it;
// the caller-supplied targetEnv can only make the plan stricter, never looser.
export function doDiagnoseJob(a: DiagnoseJobArgs) {
  let text = a.log; let derived: string | undefined; let job: unknown = { id: a.jobId };
  if (a.promotionId) {
    const p = promotionGet(a.promotionId);
    if (!p.ok || !p.info) return { ok: false, status: "promotion_lookup_failed", message: p.error };
    text ??= p.info.errorMessage; derived = p.info.destination;
    job = { id: p.info.lastDeploymentExecutionId ?? a.jobId, promotion: p.info.name, status: p.info.status };
  } else if (!text) {
    const j = fetchJob(a.jobId, a.story);
    if (!j.ok) return { ok: false, status: "job_lookup_failed", message: j.error };
    text = j.errorText; derived = j.destination; job = j.job ?? job;
  }
  if (!text) return { ok: false, status: "no_error_text", message: "No error text found for this job." };

  let env = derived ?? a.targetEnv;
  const warnings: string[] = [];
  if (derived && a.targetEnv && !sameEnv(derived, a.targetEnv)) {
    warnings.push(`targetEnv argument (${a.targetEnv}) differs from Copado's destination (${derived}); using the stricter of the two.`);
    if (isProd(a.targetEnv) && !isProd(derived)) env = a.targetEnv;
  }
  if (!env) return { ok: false, status: "no_target_env", message: "Could not determine the target environment; pass targetEnv." };

  const diagnosis = diagnose(text);
  const plan = makePlan(diagnosis, env, a.destructive ?? false);
  register(plan, diagnosis);
  if (warnings.length) audit("target_env_warning", { planId: plan.planId, warnings });
  return { ok: true, job, diagnosis, plan, ...(warnings.length ? { warnings } : {}) };
}

// ---------- gate ----------
function gate(planId: string) {
  const entry = getPlan(planId);
  if (!entry) return { entry: undefined, blocked: { ok: false, status: "unknown_plan", message: "Run diagnose first." } };
  const plan: Plan = entry.plan;
  if (plan.approvalRequired && !isApproved(plan.planId)) {
    audit("blocked_awaiting_approval", { planId: plan.planId, risk: plan.risk, targetEnv: plan.targetEnv });
    return { entry, blocked: { ok: false, status: "awaiting_approval",
      message: `Plan is ${plan.risk} risk (${plan.targetEnv}). A human must run: rg approve ${plan.planId}` } };
  }
  return { entry, blocked: undefined };
}

// ---------- remediate via Salesforce CLI (local org) ----------
// The target org is the plan's targetEnv (used as the `sf` alias); there is no separate org argument.
export interface RemediateArgs { planId: string; projectDir: string; patch?: string; branch?: string; dryRun?: boolean }

export function doRemediate(a: RemediateArgs) {
  const { entry, blocked } = gate(a.planId);
  if (blocked || !entry) return blocked;
  const plan: Plan = entry.plan;
  const log: string[] = [];
  if (a.dryRun) {
    audit("dry_run", { planId: plan.planId, targetEnv: plan.targetEnv });
    return { ok: true, status: "dry_run", message: `Approved/low risk. Would apply patch and validate against ${plan.targetEnv}.`, plan };
  }
  if (a.patch) {
    const branch = a.branch ?? `guardian/${plan.planId}`;
    const co = run("git", ["checkout", "-b", branch], a.projectDir);
    log.push(`git checkout -b ${branch}: ${co.code}`);
    const pf = join(a.projectDir, ".guardian-patch.diff");
    writeFileSync(pf, a.patch);
    const ap = run("git", ["apply", "--whitespace=nowarn", pf], a.projectDir);
    log.push(`git apply: ${ap.code} ${ap.stderr.trim()}`);
    if (ap.code !== 0) { audit("patch_failed", { planId: plan.planId, err: ap.stderr }); return { ok: false, status: "patch_failed", log }; }
    run("git", ["commit", "-am", `Release Guardian fix for ${plan.planId}`], a.projectDir);
    audit("patch_applied", { planId: plan.planId, branch });
  }
  const t = plan.testsToRun.length ? runApexTests(plan.targetEnv, plan.testsToRun, a.projectDir) : validateDeploy(plan.targetEnv, a.projectDir);
  audit("validated", { planId: plan.planId, code: t.code, tests: plan.testsToRun });
  return { ok: t.code === 0, status: t.code === 0 ? "validated" : "validation_failed", log, output: t.stdout.slice(-4000) };
}

// ---------- remediate via Copado (system of record) ----------
export interface CopadoFile { path: string; content: string }
export interface RemediateCopadoArgs { planId: string; story: string; files: CopadoFile[]; projectDir?: string; branch?: string }

const SAFE_STORY = /^[\w-]+$/;
function safeRelPath(p: string): string | null {
  const n = normalize(p).replace(/\\/g, "/");
  if (isAbsolute(p) || n.startsWith("..") || n.includes("/../") || !n.startsWith("force-app/")) return null;
  return n;
}

// Duplicate-submission guard: a plan that already produced a promotion must not publish/submit again.
function findRecentSubmission(planId: string) {
  return [...readAudit()].reverse().find((e) => e.event === "submitted" && e.planId === planId && e.promotionId);
}

export function doRemediateCopado(a: RemediateCopadoArgs) {
  const { entry, blocked } = gate(a.planId);
  if (blocked || !entry) return blocked;
  const plan: Plan = entry.plan;
  const dir = a.projectDir ?? process.env.RG_PROJECT_DIR;
  if (!dir) return { ok: false, status: "no_project_dir", message: "Pass projectDir or set RG_PROJECT_DIR to the sfdx repo." };
  const prior = findRecentSubmission(plan.planId);
  if (prior) return { ok: true, status: "already_submitted", promotionId: prior.promotionId, message: "This plan was already submitted. Call rg_verify with this promotionId instead of remediating again." };
  if (!SAFE_STORY.test(a.story)) return { ok: false, status: "bad_story", message: "Invalid story id." };
  if (!a.files?.length) return { ok: false, status: "no_files", message: "Provide at least one file." };
  const rel: string[] = [];
  for (const f of a.files) {
    const n = safeRelPath(f.path);
    if (!n) { audit("rejected_path", { planId: plan.planId, path: f.path }); return { ok: false, status: "bad_path", message: `Path must be a relative path under force-app/: ${f.path}` }; }
    rel.push(n);
  }

  const log: string[] = [];
  const branch = a.branch ?? `feature/${a.story}`;
  audit("remediation_started", { planId: plan.planId, story: a.story, files: rel, targetEnv: plan.targetEnv });

  // Same sequence you ran by hand. `work set` records the active work item that publish/submit act on, so a failure stops the run.
  const ws = agentia(["cicd", "work", "set", a.story], dir, 60_000);
  log.push(`work set: ${ws.code}`);
  if (ws.code !== 0) {
    audit("remediation_failed", { planId: plan.planId, step: "work_set", err: (ws.stderr || ws.stdout).slice(-500) });
    return { ok: false, status: "work_set_failed", log, message: (ws.stderr || ws.stdout).trim().slice(-500) };
  }
  const co = run("git", ["checkout", branch], dir);
  log.push(`git checkout ${branch}: ${co.code}`);
  if (co.code !== 0) { audit("remediation_failed", { planId: plan.planId, step: "checkout", err: co.stderr }); return { ok: false, status: "checkout_failed", log, message: co.stderr.trim() }; }

  for (let i = 0; i < a.files.length; i++) {
    const abs = join(dir, rel[i]);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, a.files[i].content);
    log.push(`wrote ${rel[i]}`);
  }
  const add = run("git", ["add", "--", ...rel], dir);
  const nothingStaged = add.code === 0 && run("git", ["diff", "--cached", "--quiet"], dir).code === 0;
  const cm = nothingStaged ? { code: 0, stdout: "", stderr: "" } : run("git", ["commit", "-m", `Release Guardian fix for ${plan.planId}`], dir);
  log.push(nothingStaged ? "git commit: skipped (already committed)" : `git commit: ${add.code === 0 ? cm.code : add.code}`);
  if (add.code !== 0 || cm.code !== 0) { audit("remediation_failed", { planId: plan.planId, step: "commit", err: cm.stderr || cm.stdout || add.stderr }); return { ok: false, status: "commit_failed", log, message: (cm.stderr || cm.stdout || add.stderr).trim() }; }

  const pub = agentia(["cicd", "work", "publish"], dir);
  log.push(`work publish: ${pub.code}${pub.timedOut ? " (timed out)" : ""}`);
  if (pub.code !== 0) { audit("remediation_failed", { planId: plan.planId, step: "publish", err: (pub.stderr || pub.stdout).slice(-500) }); return { ok: false, status: pub.timedOut ? "timed_out" : "publish_failed", log, message: "Publish failed. If this was a 500/504 gateway error it is safe to retry once." }; }

  const sub = agentia(["cicd", "work", "submit"], dir);
  log.push(`work submit: ${sub.code}${sub.timedOut ? " (timed out)" : ""}`);
  const m = (sub.stdout + sub.stderr).match(/promotion_id=(\w+)/);
  if (!m) {
    audit("remediation_failed", { planId: plan.planId, step: "submit", timedOut: sub.timedOut, err: (sub.stderr || sub.stdout).slice(-500) });
    return { ok: false, status: sub.timedOut ? "timed_out" : "submit_failed", log, message: "No promotion_id in submit output. Check rg_report before retrying." };
  }
  const promotionId = m[1];
  audit("submitted", { planId: plan.planId, story: a.story, promotionId, status: "Submitted", files: rel });

  // Make sure Copado is promoting where the plan said it would.
  const p = promotionGet(promotionId);
  if (p.ok && p.info?.destination && !sameEnv(p.info.destination, plan.targetEnv)) {
    audit("target_mismatch", { planId: plan.planId, promotionId, planTarget: plan.targetEnv, copadoDestination: p.info.destination });
    return { ok: false, status: "target_mismatch", promotionId, log,
      message: `Plan targets ${plan.targetEnv} but Copado promoted to ${p.info.destination}. Not marked ready.` };
  }
  return { ok: true, status: "submitted", promotionId, log, message: "Submitted to Copado. Call rg_verify with this promotionId until the status is Validated or Failed." };
}

// ---------- verify ----------
export function doVerify(promotionId: string) {
  const sub = [...readAudit()].reverse().find((e) => e.event === "submitted" && e.promotionId && key15(e.promotionId) === key15(promotionId));
  const planId: string | undefined = sub?.planId;
  const entry = planId ? getPlan(planId) : undefined;

  const p = promotionGet(promotionId);
  if (!p.ok || !p.info) return { ok: false, status: "promotion_lookup_failed", message: p.error };
  const { info } = p;

  const targetOk = !entry || !info.destination || sameEnv(info.destination, entry.plan.targetEnv);
  const gateOk = !entry || !entry.plan.approvalRequired || isApproved(entry.plan.planId);
  const deployOk = !info.deployStatus || /success/i.test(info.deployStatus);
  const ready = isValidated(info.status) && deployOk && targetOk && gateOk;

  audit("verified", { planId, promotionId: info.id, promotion: info.name, status: info.status, deployStatus: info.deployStatus, ready });
  return {
    ok: true, promotionReady: ready, promotion: info.name ?? info.id, status: info.status,
    ...(info.deployStatus ? { deployStatus: info.deployStatus } : {}),
    ...(!targetOk ? { warning: `Copado destination ${info.destination} does not match plan target ${entry?.plan.targetEnv}` } : {}),
    ...(!gateOk ? { warning: "Plan requires human approval that has not been granted" } : {}),
    ...(isFailed(info.status) ? { errorMessage: info.errorMessage, nextAction: `Re-run rg_diagnose_job with promotionId ${info.id}` } : {}),
  };
}

// ---------- report ----------
// Readiness is per promotion: the LATEST promotion must be verified Validated, on the planned target,
// with approval satisfied. An earlier validated promotion no longer makes the release "ready".
export function doReport(planId?: string) {
  const events = readAudit().filter((e) => !planId || e.planId === planId);
  const byPromo = new Map<string, { id: string; name?: string; status: string; ready: boolean; planId?: string }>();
  for (const e of events) {
    if ((e.event === "submitted" || e.event === "verified") && e.promotionId) {
      const k = key15(e.promotionId);
      const prev = byPromo.get(k);
      byPromo.delete(k); // re-insert so the Map stays ordered by most recent activity
      byPromo.set(k, {
        id: e.promotionId, name: e.promotion ?? prev?.name, planId: e.planId ?? prev?.planId,
        status: e.status ?? prev?.status ?? "Submitted",
        ready: e.event === "verified" ? e.ready === true : false,
      });
    }
  }
  const promotions = [...byPromo.values()];
  const latest = promotions[promotions.length - 1];
  const latestPlan = latest?.planId ? getPlan(latest.planId) : undefined;
  const pendingApproval = !!latestPlan?.plan.approvalRequired && !isApproved(latestPlan.plan.planId);
  const ready = !!latest?.ready && !pendingApproval;

  const md = [`# Release Guardian report${planId ? ` - ${planId}` : ""}`, "",
    ...events.map((e) => `- \`${e.ts}\` **${e.event}** ${JSON.stringify({ ...e, ts: undefined, event: undefined })}`),
    "", "## Promotions",
    ...(promotions.length ? promotions.map((p) => `- ${p.name ?? p.id}: ${p.status}${p.ready ? " (ready)" : ""}`) : ["- none"]),
    "", `**Latest promotion ready:** ${ready ? "YES" : "NO"}${pendingApproval ? " (awaiting human approval)" : ""}`].join("\n");
  return { promotionReady: ready, promotions, pendingApproval, lastEvent: events[events.length - 1]?.event, markdown: md };
}