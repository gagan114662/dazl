# Static quality evidence gate

`static-quality` is a local-only ESLint/TypeScript analysis ratchet, not Sonar's
engine, a REA runtime invocation, or proof that code is perfect. It complements
strict TypeScript, both database suites, migrations, production-browser tests,
negative failure tests, independent review and live acceptance.

## REA's actual contribution

The user asked to use [REA](https://github.com/morluto/rea). REA is Reverse
Engineer Anything, not a source-code quality scanner. We inspected its
[EvidenceLedger](https://github.com/morluto/rea/blob/aa48d494e9726d469a1b9ed917f021d8a1a4c7ea/src/application/investigation/EvidenceLedger.ts)
and [CdpCaptureCompleteness](https://github.com/morluto/rea/blob/aa48d494e9726d469a1b9ed917f021d8a1a4c7ea/src/browser/CdpCaptureCompleteness.ts).
This gate applies their design ideas: validate before accepting evidence,
semantic identities rather than counts alone, and explicit unavailable/partial
coverage rather than quietly passing. `evidence.mjs` and the report schema are
independent implementations for lint evidence. No REA code was copied, installed
or executed; no binary, target app, customer capture, model or external service
is used. REA authored code is [MIT](https://github.com/morluto/rea/blob/aa48d494e9726d469a1b9ed917f021d8a1a4c7ea/LICENSE);
third-party engines have their own terms. This is design reuse, not a claim that
REA analyzed dazl.

## What runs

The exact PR head (not a synthetic merge commit) and exact PR base SHA are
archived from git. Push runs use `before`; manual runs require an explicit base.
Both trees use the head's same locked tools and ESLint configuration. Every
tracked web JS/TS candidate is accounted for; ignored files are named in the
report. Missing/invalid base, non-ancestor base, missing source, parser failure,
invalid rules, missing results, timeout, child crash and empty analysis reject
or report `unavailable`, never green. Full-history checkout supports forks;
missing history is an error, not an empty baseline.

Rules include the existing Next/TypeScript/React ESLint rules, plus `no-eval`,
`no-new-func`, `no-implied-eval`, `no-debugger`, `no-unreachable`, and constant
conditions (intentional loops exempt). App/lib TypeScript additionally uses the
TypeScript program for floating promises, misused promises and await-thenable.
Void-return checks for event-handler compatibility are disabled explicitly;
this gate does not claim to detect every async misuse. Inline ESLint directives
cannot disable the gate. CI installs the locked dependencies with lifecycle
scripts disabled. Node 22.23.3 is selected explicitly.

A finding's identity includes file, rule, severity, diagnostic identifier or
stable headline, and complete affected source lines. Whole lines prevent a
changed eval argument being hidden under the same callee span. Line numbers and
React compiler's embedded display paths/code frames are excluded from identity.
Multiplicity is retained: adding another identical finding still fails. Pure
line movement is stable; a rename is conservatively new, a deletion retires its
debt. Formatting or editing a line with legacy debt can require fixing it.

The initial full scan on 213faf1a found 237 findings under this stronger policy,
with zero excluded source files. They remain **existing debt**, not ignored
files or a statement of safety. No editable baseline JSON is committed. Fixes
reduce the next base's debt; new findings fail even if total counts fall.

The gate also parses every workflow YAML and validates basic job/step shape. An
unquoted colon in a step name, duplicate key or empty jobs fails calibration or
validation. This is not full GitHub expression/permission validation; actual
executed checks remain the evidence of execution, and absent jobs are not pass.

## Run and inspect

From `web`, after `npm ci --ignore-scripts`:

```
node --test scripts/quality/calibration.test.mjs scripts/quality/integration.test.mjs
node scripts/quality/gate.mjs --base <full-ancestor-sha> --report ../quality-report.json
```

The tracked tree must be clean. Reports contain exact base/head, policy hashes,
file accounting, existing debt, new findings with locations and semantic hashes,
and limitations. Source lines and credential values are not serialized. Failed
runs upload a report where one exists; upload absence also fails the job.

Calibration uses both actual ESLint red plants and temporary real git repos.
It verifies comments versus code, inline disables, typed async bugs, duplicate
findings, count-preserving substitutions, path/line movement, renames, deletion,
new files, parser errors, invalid rules, invalid/missing bases and shallow clones.
These fixtures never call providers or write business databases.

## Review and enforcement

Policy/tool/config/workflow changes are security-sensitive and require
independent review of their impact. A check cannot authenticate its own edited
policy. Compare the report's policy hashes and changed dependency locks, inspect
rules, and rerun red plants. Do not resolve false positives with a silent skip,
`continue-on-error`, a mutable baseline, or a success-only empty artifact.
Fix the code or make a narrow, reviewed policy correction with a negative test.

The workflow has no path filter, no `pull_request_target`, write token or secret
access, and leaves checkout credentials out of the git config. Its lint run can
load repository ESLint config, so untrusted forks must stay on isolated hosted
runners with no secrets, as configured. No external code upload occurs.

Rollout is separate from adding the workflow: after exact-head independent
review and CI evidence, add `static-quality` to `ops/checked_launch.py`'s
`REQUIRED_CI` and configure repository protection as appropriate. Until then it
runs and rejects bad PR checks but is not claimed to be an unbypassable merge or
deploy restriction. Existing release checks must stay intact. Never merge a
pending, failed, cancelled, unavailable or missing quality check once enforced.

## What it cannot establish

Python, shell, SQL, workers, installed dependency source, runtime paths, business
consent, tenant authority, PG concurrency, source freshness, UI pixels and lead
yield are outside this analysis. Static checks cannot detect all regressions.
Every confirmed incident still needs the relevant behavioral regression and
failure fixture; passing this check does not waive any existing acceptance gate.
