# \# Release Guardian

# 

# Governed failure diagnosis and remediation for Salesforce releases on Copado, exposed as an MCP server plus a small CLI.

# Copado stays the system of record (pipelines, gates, promotions). Release Guardian adds failure triage, a risk-scored plan,

# a human approval gate for anything risky, and an audit trail.

# 

# \## Architecture

# 

# ```mermaid

# flowchart LR

# &#x20; A\[Copado job fails] --> B\[MCP: rg\_diagnose\_job]

# &#x20; B --> C\[Classifier]

# &#x20; C --> D\[Planner / risk gate]

# &#x20; D -->|low risk| F\[rg\_remediate\_copado]

# &#x20; D -->|medium / high risk| E\[Human: rg approve planId]

# &#x20; E --> F

# &#x20; F -->|write files, commit, publish, submit| G\[Copado promotion]

# &#x20; G --> H\[rg\_verify]

# &#x20; H -->|Validation failed| B

# &#x20; H -->|Validated| I\[Ready]

# &#x20; B -.-> J\[(audit.jsonl)]

# &#x20; D -.-> J

# &#x20; E -.-> J

# &#x20; F -.-> J

# &#x20; H -.-> J

# ```

# 

# \## Requirements

# 

# \- Node.js and npm

# \- A Copado org with the Agentia CLI (`agentia`) installed and authenticated (`agentia setup`)

# \- A clone of the Salesforce repo that Copado promotes from; set `RG\_PROJECT\_DIR` to it

# \- An MCP client such as Cursor or Claude Code

# 

# \## Setup

# 

# &#x20;   npm install \&\& npm run build

# &#x20;   npm test            # readiness / approval-gate unit test

# 

# MCP config (Cursor / Claude Code):

# 

# &#x20;   { "mcpServers": { "release-guardian": {

# &#x20;       "command": "node", "args": \["C:/abs/path/release-guardian/dist/server.js"],

# &#x20;       "env": { "RG\_PROJECT\_DIR": "C:/abs/path/sfdx-repo" } } } }

# 

# State (`audit.jsonl`, `plans.json`, approvals) lives in `<package>/.guardian` by default, so the MCP server and the CLI

# always agree regardless of their working directory. Override with `GUARDIAN\_DIR` (absolute path).

# 

# \## Tools

# 

# | Tool | Purpose |

# |---|---|

# | `rg\_diagnose` | Classify a pasted log, return a plan (read-only) |

# | `rg\_diagnose\_job` | Diagnose a Copado job/promotion; target env comes from Copado, `targetEnv` can only make the plan stricter |

# | `rg\_remediate\_copado` | Write files on `feature/<story>`, commit, `work publish`, `work submit`. Target comes from the plan. Gated |

# | `rg\_verify` | Check a promotion. `promotionReady` needs Validated + successful deploy + planned target + approval if required |

# | `rg\_remediate` | Local `sf` CLI path (patch + targeted tests), target = plan's env alias. Gated |

# | `rg\_report` | Audit trail and per-promotion readiness (latest promotion decides) |

# 

# Publish plus submit can take several minutes, longer than most MCP clients wait, so the call may time out even though the

# submission succeeded. Calling `rg\_remediate\_copado` again with the same plan is safe: it returns `already\_submitted` with the

# existing `promotionId` and creates no duplicate promotion. `rg\_report` shows the same `submitted` event.

# 

# \## Human approval (out-of-band)

# 

# &#x20;   node dist/cli.js plans

# &#x20;   node dist/cli.js approve <planId>

# &#x20;   node dist/cli.js report \[planId]

# 

# \## Governance rules

# \- Non-production + non-destructive + classified = low risk, the agent may proceed.

# \- Production, destructive changes, permission changes, unclassified failures = approval required.

# \- `rg\_remediate\_copado` only writes relative paths under `force-app/`.

# \- After submit, Copado's destination is compared with the plan's target; a mismatch is audited and never marked ready.

# 

# \## Demo results (Copado trial org, pipeline Dev1 -> INT -> UAT -> Production)

# 

# | Scenario | Outcome |

# |---|---|

# | Apex class referencing a missing field (`Account.Segment\_\_c`), validation into INT-SFP failed | Agent diagnosed `MISSING\_DEPENDENCY` (low risk), wrote the field with `rg\_remediate\_copado`, and promotion P00014 reached Validated |

# | `rg\_remediate\_copado` call timed out in the client | Agent recovered the `promotionId` from `rg\_report` instead of retrying |

# | Same call repeated for the same plan | Returned `already\_submitted` with the same promotion; no duplicate created |

# | Same Apex failure with a Production target | Plan risk `high`; `rg\_remediate` returned `awaiting\_approval` until a human ran `rg approve`, then the dry run succeeded |

# 

# \## Known limitations

# \- Approval is a file written by `rg approve`. No MCP tool can create it, but an agent with shell access could run the CLI.

# \- The classifier is regex-based; an LLM fallback for `UNKNOWN` failures is not implemented.

# \- `rg\_diagnose\_job` finds the job through `agentia cicd work status` (pass `story`, or it uses the last work item set), so `RG\_PROJECT\_DIR` must point at the sfdx repo.

# \- `rg\_remediate\_copado` stops if `work set <story>` fails, because publish and submit act on the recorded work item.

