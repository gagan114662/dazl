# DESIGN (PROPOSAL, NOT IN EFFECT): Acceptance Contract — write the finish line down before coding

**Status: proposal only.** Nothing here changes how work is picked up, branched or reviewed. Making an agreed
contract a precondition for opening a branch would change the owner's process, so it needs the owner's own words
(date, scope) before it lands in `docs/PROCESS.md` or `.claude/skills/full-stop/SKILL.md` (PR #641 review,
2026-11-04, point 3). This PR does not enact it, and a builder PR cannot.

## The gap it targets

`docs/design/issue-closure-gate.md` covers issues that are done but never closed, and keeps closing manual. It
does not cover issues whose finish line was never written down, so a builder ships something that passes its own
tests and still misses a step that only shows up in real use. A test gate cannot catch a gap in the test's own
premise (Instinct, PR #641 review point 5: the contract for each issue must state the user journey, failure cases,
live verification route and any access/spend before coding).

## Proposed template (an `## Acceptance Contract` section in the issue)

```markdown
## Acceptance Contract

1. **User journey** (exact actor, exact steps, starting state): ...
2. **Failure / edge cases this must handle**: ...
3. **Live verification** (the literal command or click-path that will be run on the deployed app; not
   "test it works"): ...
4. **Access or spend needed** (API keys, sandbox account, budget, DB/table access), and who provides it: ...
```

Item 3 is the point: the builder's own proof and the reviewer's live check should be the same procedure, so the
gap between them cannot hide a missed step. Item 4 surfaces missing access or budget before a PR is blocked on it.

## Open for the owner (not decided here)

- Whether an agreed contract becomes a precondition for branching, and who agrees it.
- Whether a live sandbox check can stand in for item 3 on some issue classes. The only candidate today is the CRM
  push harness (`web/scripts/crm-live-acceptance.mts`, #634). `acceptance-gate.yml` has a
  `crm-sandbox-acceptance` job for it that never runs on pull requests (a key next to the PR head's own
  `web/lib/crm` code could be read by any same-repo PR that edits it). It runs only on manual dispatch from main,
  and only if a sandbox key exists; otherwise it is reported SKIPPED, never green. No key exists. Provisioning
  one (an environment-scoped secret limited to main, never a repo secret) is the owner's call, not a builder's.
- Issues touching real production data, sends or billing have no such path; the reviewer stays the live checker.

## Limits

This has not been tried on a real issue. Nothing here closes issues or changes who merges or closes.
