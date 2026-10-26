import { agentia } from "./exec.js";

export interface PromotionInfo {
  id: string; name?: string; status: string; deployStatus?: string;
  source?: string; destination?: string; errorMessage?: string; lastDeploymentExecutionId?: string;
}

// `agentia cicd promotion get <id> --json` is the source of truth for promotion state.
export function promotionGet(id: string): { ok: boolean; info?: PromotionInfo; error?: string } {
  const r = agentia(["cicd", "promotion", "get", id, "--json"], process.env.RG_PROJECT_DIR, 60_000);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).slice(-500) };
  try {
    const start = r.stdout.indexOf("{");
    const j = JSON.parse(r.stdout.slice(start));
    const p = j.result ?? j;
    return { ok: true, info: {
      id: p.id, name: p.identification?.promotionName, status: p.status,
      deployStatus: p.lastDeploymentExecutionStatus,
      source: p.sourceEnvironmentName, destination: p.destinationEnvironmentName,
      errorMessage: p.executionErrorMessage, lastDeploymentExecutionId: p.lastDeploymentExecutionId,
    } };
  } catch { return { ok: false, error: "could not parse promotion JSON" }; }
}

export const isValidated = (s?: string) => /^validated$/i.test(s ?? "");
export const isFailed = (s?: string) => /fail|error/i.test(s ?? "");
// Copado ids appear as 15 or 18 chars depending on the command; compare on the first 15.
export const key15 = (id: string) => id.slice(0, 15);
export const sameEnv = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
