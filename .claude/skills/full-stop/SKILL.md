---
name: full-stop
description: The default way to finish a change in dazl. Trigger this if the user says 'full stop' (even as a closing "Full stop." that reads like emphasis) or 'full send', or asks to get a PR ready for Instinct. Proves the change, reviews it with the council, files the PR, babysits CI, then stops for Instinct to merge.
---

> Vendored from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT, see `../LICENSE-tstack`) and adapted for
> dazl. In tstack, full-stop defers to full-send; here it holds the workflow itself, because in dazl nobody but
> Instinct merges. See `../README.md` for every change from upstream.

# Full Stop (the dazl default)

In dazl, Instinct reviews and is the only one who merges and deploys (`docs/PROCESS.md`). Every change goes the same
way: **prove, review, file, babysit CI, then stop for Instinct.** You own the work from its current state to a PR
that is ready for Instinct. Your updates may go unread until you stop, so do not stop early.

## Steps

1. **Finish the change.** Do the smallest change that meets the goal. Fix the case that happened, not every case
   that could. Work on a branch, never on `main`. Keep at most two of your PRs open at a time.
2. **Prove it.** Get proof for every change you made. See "Proof".
3. **Review it with the `council` skill.** The three reviewer agents (`.claude/agents/reviewer-*.md`) review the
   change; fix what they rightly find and loop until they agree, or until a disagreement is written down for
   Instinct. For a small change you may use `sol-loop` (one reviewer, not your own model) instead; say which you
   used.
4. **File the PR with the `file-pr` skill.** Bring `main` in first (see "Updating from main"). Put the council
   result and one line on how you proved the change in the description.
5. **Babysit the PR with the `babysit-pr` skill.** Fix real CI failures and review findings. Prove each fix
   before you push it. When a fix changes behavior, run the council again on the new diff.
6. **Stop at the gate and hand off.** See "Ready for Instinct".

Stay active from step 1 to step 6. If you end your turn while CI is running, make sure something wakes you (see
`babysit-pr`); never sleep-poll.

## Proof

Proof is evidence you observed yourself in this session: command output, a reproduction, a screenshot. Use the most
direct proof the change allows:

- Reproduce the original failure, apply the fix, then watch the same reproduction pass.
- Run the checks CI runs: `npx tsc --noEmit`, eslint on the files you touched, and the tests (`npm --prefix web
  test`, with a local Postgres for the Postgres half; see `web/test/helpers/pg-test.ts`).
- Add one focused test that fails without the fix, when the behavior has none.
- For UI, build and render it (`web/test/ui/*.ui.mjs` patterns: real production build, stubbed `/api/*`) at desktop
  and 390px, and look at the screenshots. Green mocked tests do not prove the user experience works.

A "full stop" request is permission to use those methods (local builds, browser automation against a local server,
screenshots) without asking first. **It never overrides dazl's safety rules:** no paid scans, no live CRM, review,
draft, export or send calls, no enrichment credits, no autopilot or signed-in collection, no production data,
database or configuration, no real mailbox, no live Stripe; tests stay isolated and stubbed; fixtures and
screenshots use synthetic data, never real run ids or private data. If a change can only be proven by one of those,
stop and say what Instinct needs to verify.

When you cannot prove a change, you do not have full confidence. Say so in the handoff.

## Never merge

You may commit and push to this task's own branch. Never merge, enable auto-merge, enter a merge queue, push to
`main`, close a PR, bypass branch protection, or ask another agent to do any of those. Instinct merges.

### Updating from main

Instinct reviews exact head SHAs, so never rewrite a branch someone has reviewed: bring `main` in with a merge
commit, resolve conflicts, prove again, and push normally. Rebasing and `--force-with-lease` are only for your own
branch before anyone has seen it.

## Ready for Instinct

The PR is ready when all of these are true on the latest commit:

- Your proof covers every change in the diff.
- The council (or sol-loop) approved the current behavior diff, or each open disagreement is written in the PR.
- CI is green on the exact head.
- Every Instinct finding is fixed, or answered with a reason on the PR.
- The branch is mergeable with `main` (no conflicts).

Then stop and report, on the PR and to the user: the PR link, the **exact head SHA**, the test commands and their
output, the council result, what is NOT verified, and that the PR is open and unmerged, waiting for Instinct.

If something blocks readiness, say what blocks it, what you tried, and what you need. Ask the user with the
harness's question tool when you cannot continue alone (proof impossible within the safety rules, the goal is
ambiguous, another PR makes this one obsolete). If there is no question tool, leave the PR open and start your final
message with the question.
