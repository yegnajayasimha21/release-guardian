export type FailureType =
  | "MISSING_DEPENDENCY"
  | "VALIDATION_RULE"
  | "APEX_TEST_FAILURE"
  | "PERMISSION"
  | "COVERAGE"
  | "UNKNOWN";

export interface Diagnosis {
  type: FailureType;
  confidence: number;
  summary: string;
  evidence: string[];
  components: string[];   // metadata components implicated (e.g. Account.Region__c)
  failedTests: string[];  // ApexClass.method
}

const rules: { type: FailureType; re: RegExp; summary: string; confidence: number }[] = [
  { type: "MISSING_DEPENDENCY", confidence: 0.9,
    re: /(No such column|Variable does not exist|Invalid field|Entity of type '?\w+'? named '?[\w.]+'? cannot be found|no (CustomField|ApexClass|Flow|CustomObject) named)/i,
    summary: "A component references metadata that is not present in the target (missing from the promotion or the org)." },
  { type: "VALIDATION_RULE", confidence: 0.85,
    re: /FIELD_CUSTOM_VALIDATION_EXCEPTION/i,
    summary: "A validation rule blocked a DML operation, most likely test data that no longer satisfies it." },
  { type: "APEX_TEST_FAILURE", confidence: 0.8,
    re: /(System\.AssertException|System\.DmlException|System\.NullPointerException|Test failure|tests? failed|Methods? Failed)/i,
    summary: "One or more Apex tests failed." },
  { type: "PERMISSION", confidence: 0.8,
    re: /(INSUFFICIENT_ACCESS|insufficient access|not have access|permission set|FIELD_INTEGRITY_EXCEPTION)/i,
    summary: "Access or permission problem (profile, permission set or sharing)." },
  { type: "COVERAGE", confidence: 0.85,
    re: /(code coverage|Average test coverage|coverage of \d+%)/i,
    summary: "Code coverage requirement not met." },
];

export function diagnose(log: string): Diagnosis {
  const lines = log.split(/\r?\n/);
  const hit = rules.find((r) => r.re.test(log));
  const evidence = hit
    ? lines.filter((l) => hit.re.test(l)).slice(0, 5).map((l) => l.trim())
    : lines.filter((l) => /error|fail/i.test(l)).slice(0, 5).map((l) => l.trim());

  const comps = new Set<string>();
  for (const l of lines) {
    const m1 = l.match(/No such column '([\w.]+)'/i) || l.match(/Variable does not exist: ([\w.]+)/i)
      || l.match(/Invalid field ([\w.]+)/i) || l.match(/named '?([\w.]+)'? cannot be found/i);
    if (m1) comps.add(m1[1]);
  }
  const tests = new Set<string>();
  for (const l of lines) {
    const m = l.match(/^\s*(\w+)\.(\w+)\s*(?::|\s)\s*(Fail|Failure|Error)/i);
    if (m) tests.add(`${m[1]}.${m[2]}`);
  }

  return {
    type: hit?.type ?? "UNKNOWN",
    confidence: hit?.confidence ?? 0.2,
    summary: hit?.summary ?? "Could not classify the failure from the log; human review needed.",
    evidence,
    components: [...comps],
    failedTests: [...tests],
  };
}
