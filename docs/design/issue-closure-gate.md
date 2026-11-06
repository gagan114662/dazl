# DESIGN: issue-closure gate — closing stays manual and live; tagged tests are additive evidence

## Problem

Reading the PR/issue history (559 PRs, 81 issues) turns up a pattern: issues with 3-10 merged PRs stay open, and
Instinct keeps finding gaps in work already reviewed and merged. Causes:

1. **No standing, re-runnable link between an issue's reported scenario and a test.** Some builders name tests
   after the issue (`#569 repro`, `#569 read-back`), but not uniformly, and nothing checks that they still pass.
2. **Mega-issues (e.g. #533, 9+ PRs) have no tracked sub-checklist**, so "another PR landed" looks like progress
   without anyone being able to say what is left.
3. **Finish lines that were never written down** (journey, failure cases, live check, access/spend). A test gate
   cannot fix this; see the separate, not-in-effect proposal `docs/design/acceptance-contract.md`.

A prior attempt (2026-10-30, the "8-point Instinct gate") was self-attested prompt text ("GATE 8/8"). It did not
reduce review rounds, because self-attestation is not verification.

What this design deliberately does **not** do: make merges close issues. The owner rule is that an issue closes
only after the fix is deployed and verified live (owner comment on #569, 2026-11-02, after a PR body auto-closed
#569 from an offline pin). Using `Refs #N` everywhere is the correct convention, not the cause of the backlog.

## What this PR adds

- `docs/PROCESS.md` § "Closing issues": builders never use closing keywords; the reviewer/owner closes after live
  proof and records the deployed commit, the real-provider or real-user-journey result and the cleanup. A passing
  tagged test is necessary evidence, never sufficient. Plus the 3+-PRs checklist rule.
- `web/scripts/gate-check.mjs <N>`: finds tests whose own `test()`/`it()` NAME contains `#N` (not a comment, not a
  `describe()` title, not `#N0`), runs those files with a reporter that records every test's result, and prints
  `GATE #N: PASS|FAIL — reason (tagged executed=X passed=X failed=X skipped=X todo=X; other failures=X; runner
  exit=X)`. PASS needs at least one executed, non-skipped tagged test, all passing, and nothing else in those files
  failing. Bad arguments exit 2. `--list` is a static scan used by CI. Tested by `web/test/gate-check.test.ts`
  (fixtures in `web/test/fixtures/gate-check/`, which the real gate does not scan).
- `.github/workflows/acceptance-gate.yml`, where every job reports what it really did (green = ran and passed,
  red = ran and failed, SKIPPED = nothing to run, by job-level `if`; no step maps "not run" to success):
  - `no-closing-keywords`: fails if the PR body or any PR commit message has `Closes/Fixes/Resolves` + an issue
    reference (#N, owner/repo#N, or an issues URL).
  - `tag-scope` → `tagged-tests`: for each `Refs #N` with a tagged test, runs `gate-check`; skipped when there is
    none. Additive evidence only.
  - `crm-sandbox-preflight` → `crm-sandbox-acceptance`: never runs on pull requests (SKIPPED), so no sandbox key
    can sit next to PR-head code. Runs only on manual dispatch from main, only when a sandbox key exists. No key
    exists, and adding one is an owner decision. The harness's own exit codes (2 refused, 1 failed) fail the job.

## Worked example, and what it does not prove

`node web/scripts/gate-check.mjs 569` on this branch: `GATE #569: PASS` with 3 tagged tests executed and passed
(full output in the PR comment for the exact head). That is offline evidence that the offline #569 repro still
holds. It is not evidence that #569 is done: #569's acceptance is provider-side (real HubSpot/Pipedrive
read-back on a sandbox account, tracked in #634). #569 stays open.

An earlier version of this doc and the PR body claimed "36 of 37 pass, one unrelated runner failure". No log
backed it, and Instinct could not reproduce it at c57c103b (Node 22: 37/37). It is withdrawn. For the record, the
one way found to get a failure in these files on the Windows builder PC is running them from a git worktree whose
`node_modules` is a junction without `NODE_OPTIONS=--preserve-symlinks` (`NextRequest is not a constructor` in
the crm route test); that is a local environment artefact, not a CI or code result.

## Not changed

Who merges or closes (Instinct/owner), review strictness, branch protection. `acceptance-gate.yml` is not a
required check; making any job required is a repo-settings change for the owner.
