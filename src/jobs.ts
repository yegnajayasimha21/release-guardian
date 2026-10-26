import { agentia } from "./exec.js";
import { key15 } from "./copado.js";

// Looks up a Copado job execution (e.g. a0sh...) through `agentia cicd work status`,
// which lists the work item's job executions with their error messages and destinations.
export interface JobLookup {
  ok: boolean;
  job?: { id: string; name?: string; status?: string; failedStep?: string };
  errorText?: string;
  destination?: string;
  error?: string;
}

export function parseJobFromStatus(statusJson: any, jobId: string): JobLookup {
  const jobs: any[] = statusJson?.result?.jobs ?? [];
  const j = jobs.find((x) => x?.id && key15(x.id) === key15(jobId));
  if (!j) return { ok: false, error: `Job ${jobId} was not found among this work item's job executions. Pass the right story, or run work set for it.` };
  if (!j.errorMessage) return { ok: false, error: `Job ${j.name} has no error message (status: ${j.status}).` };
  return {
    ok: true,
    job: { id: j.id, name: j.name, status: j.status, failedStep: String(j.templateName ?? "").replace(/^SFDX\s+/i, "") || undefined },
    errorText: j.errorMessage,
    destination: j.destinationName,
  };
}

const SAFE = /^[\w-]+$/;

export function fetchJob(jobId: string, story?: string): JobLookup {
  const dir = process.env.RG_PROJECT_DIR;
  if (!dir) return { ok: false, error: "Set RG_PROJECT_DIR to the sfdx repo (the folder containing .agentia)." };
  if (story && !SAFE.test(story)) return { ok: false, error: "Invalid story id." };
  // Without a story, `work status` uses the last work item recorded by `work set`.
  const r = agentia(["cicd", "work", "status", ...(story ? [story] : []), "--json"], dir, 60_000);
  let j: any;
  try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))); } catch { return { ok: false, error: (r.stderr || r.stdout).slice(-500) || "could not parse work status output" }; }
  if (j?.error) return { ok: false, error: String(j.error.message ?? "work status failed").slice(0, 500) };
  return parseJobFromStatus(j, jobId);
}
