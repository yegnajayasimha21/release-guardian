import { Diagnosis } from "./classifier.js";

export type Risk = "low" | "medium" | "high";

export interface Plan {
  planId: string;
  risk: Risk;
  approvalRequired: boolean;
  targetEnv: string;
  steps: string[];
  testsToRun: string[];
  rationale: string;
}

const PROD = /prod/i;
export const isProd = (env: string) => PROD.test(env);

export function makePlan(d: Diagnosis, targetEnv: string, destructive = false): Plan {
  let risk: Risk = "low";
  const reasons: string[] = [];
  if (PROD.test(targetEnv)) { risk = "high"; reasons.push("target is a production environment"); }
  if (destructive) { risk = "high"; reasons.push("change contains destructive metadata"); }
  if (d.type === "PERMISSION" && risk === "low") { risk = "medium"; reasons.push("permission changes widen access"); }
  if (d.type === "UNKNOWN") { risk = risk === "low" ? "medium" : risk; reasons.push("failure not classified"); }

  const steps: string[] = [];
  switch (d.type) {
    case "MISSING_DEPENDENCY":
      steps.push(`Locate missing component(s): ${d.components.join(", ") || "see evidence"}`,
        "Add the component(s) to the promotion/user story or create them on the feature branch",
        "Re-validate the deployment"); break;
    case "VALIDATION_RULE":
      steps.push("Identify the validation rule from the error message",
        "Fix test data (preferred) rather than loosening the rule",
        "Re-run the failing tests"); break;
    case "APEX_TEST_FAILURE":
      steps.push("Read the stack trace for the failing test(s)", "Patch code or test on a feature branch",
        "Re-run the failing tests only"); break;
    case "PERMISSION":
      steps.push("Identify missing access (FLS/object/permission set)", "Propose a minimal permission change", "Re-validate"); break;
    case "COVERAGE":
      steps.push("Find classes below threshold", "Add targeted tests", "Re-run tests with coverage"); break;
    default:
      steps.push("Escalate to a human with the collected evidence");
  }
  return {
    planId: `plan-${Date.now()}`,
    risk,
    approvalRequired: risk !== "low",
    targetEnv,
    steps,
    testsToRun: d.failedTests,
    rationale: reasons.length ? `Risk ${risk}: ${reasons.join("; ")}.` : "Low risk: non-production, non-destructive.",
  };
}
