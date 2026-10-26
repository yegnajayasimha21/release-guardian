import { spawnSync } from "node:child_process";

export interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }
export interface RunOpts { timeoutMs?: number; shell?: boolean }

export function run(cmd: string, args: string[], cwd?: string, opts: RunOpts = {}): RunResult {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: opts.shell ?? false, timeout: opts.timeoutMs });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut };
}

// Targeted Apex tests via Salesforce CLI.
export function runApexTests(org: string, tests: string[], cwd?: string): RunResult {
  const args = ["apex", "run", "test", "--target-org", org, "--result-format", "human", "--wait", "20", "--synchronous"];
  for (const t of tests) args.push("--tests", t);
  return run("sf", args, cwd);
}

// Check-only validation deploy of the project source.
export function validateDeploy(org: string, cwd?: string): RunResult {
  return run("sf", ["project", "deploy", "validate", "--target-org", org, "--source-dir", "force-app", "--wait", "30"], cwd);
}

// Adapter for the Agentia Headless CLI (Copado stays the system of record).
// On Windows the CLI is usually a .cmd shim, which needs a shell; args here never contain spaces.
export function agentia(args: string[], cwd?: string, timeoutMs = 180_000): RunResult {
  const bin = process.env.AGENTIA_BIN ?? "agentia";
  // Args can originate from an LLM and Windows needs a shell for the .cmd shim: allow only plain tokens.
  if (args.some((a) => !/^[\w.\-:=/@]+$/.test(a)))
    return { code: 1, stdout: "", stderr: "refused: unsafe characters in agentia argument", timedOut: false };
  return run(bin, args, cwd, { timeoutMs, shell: process.platform === "win32" });
}
