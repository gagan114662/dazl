# DESIGN: issue-closure gate — why 40+ merged PRs don't close their issues

## Problem

Reading the full PR/issue history (559 PRs, 81 issues) turns up a consistent pattern: issues that have had
3-10 PRs merged against them stay open, and Instinct keeps finding gaps in work that was already reviewed and
merged. Three concrete causes, all structural, none about model capability:

1. **PR descriptions reference issues ("refs #N", "(#N)") instead of closing them ("Closes #N").** GitHub only
   auto-closes an issue on a merged PR that uses a closing keyword in its body. This repo's convention never
   does that, so every issue needs a human (Instinct) to notice independently that it's actually done and close
   it by hand — a step that's easy to skip, especially under the "done = Instinct's live check" bar, which means
   nobody goes back to re-check and close issues whose fix already shipped.

   Concrete instance: **issue #569** ("CRM push reports success without verifying the provider actually
   created/updated the record") has 3 merged PRs against it (#441, #573, #634). `web/lib/crm/index.ts`'s
   `pushLead` already requires a nonempty id and a read-back confirmation for both HubSpot and Pipedrive — the
   exact bug described in the issue is fixed in the code on `main` today. The issue is still open. Running the
   tests that already exist and are already tagged `#569` (`test/crm-contract.test.ts`, `test/crm-acceptance.test.ts`,
   `test/crm-recorded-fixtures.test.ts`, `test/crm.test.ts`) confirms it: 36 of 37 assertions pass; the one
   failure is a Node-test-runner subprocess output-count assertion unrelated to the CRM logic (every error the
   subprocess logged during that run is itself a correct refusal the fix is supposed to produce) — worth Instinct
   confirming on the pinned CI Node version, separately from this issue. **This issue should very likely already
   be closed; nobody did it.**

2. **No standing, re-runnable link between an issue's reported scenario and a test.** Builders already tag tests
   with the issue number in comments (`#569 repro`, `#569 read-back`) — that convention exists, just not
   uniformly, and nothing checks it. So Instinct has to manually re-verify the original live scenario on every
   review round for every PR, by hand, every time — which is why review needs "1-5 rounds per PR" (the
   2026-10-30 retro). A mechanical check that the tagged test exists and passes turns most of that manual
   re-verification into something CI does for free.

3. **Mega-issues (e.g. #533, 9+ PRs, still open) have no tracked sub-checklist.** Each PR chips at a different
   corner of a multi-part issue with no visibility into what's left, so "another PR landed" looks like progress
   without anyone being able to say how close to done the issue actually is.

A prior attempt to fix this (2026-10-30, the "8-point Instinct gate") added a checklist as *prompt text* injected
into a cron job on Armaan's laptop, self-attested by the builder ("GATE 8/8"). It didn't reduce review rounds,
because self-attestation isn't verification — it moved the same manual burden to a different piece of text
without giving Instinct anything mechanical to trust instead of re-checking by hand. This design replaces it with
something that runs and produces a pass/fail, not a sentence.

## What this PR adds

- `web/scripts/gate-check.mjs`: given issue numbers, finds test files under `web/test/` tagged `#<N>` (the
  convention already used for #569), runs them, and prints `GATE #<N>: PASS|FAIL — <reason>`. No tagged test =
  FAIL. Tagged test that doesn't pass = FAIL. This is runnable by a builder before filing, by CI on every PR, and
  by Instinct as a thirty-second trust check instead of a manual live re-run.
- `.github/workflows/acceptance-gate.yml`: on every PR, reads the PR body for `Closes #N` / `Fixes #N` /
  `Resolves #N`, and runs `gate-check.mjs` against each such N. A PR that claims to close an issue but has no
  passing tagged test for it fails this check.
- `docs/PROCESS.md` additions: the closing-keyword convention (close with a closing keyword only when the
  issue's own repro now passes as a tagged test; use `refs #N` for partial work), and the mega-issue checklist
  rule (3+ PRs against an issue with no close → next builder edits the issue into a `- [ ]` checklist before
  opening another PR against it).
- `.claude/skills/full-stop/SKILL.md` additions: "Proof" now asks for a committed tagged test, not just a
  chat-visible reproduction, whenever the PR claims to close an issue; "Ready for Instinct" adds the gate-check
  result as a checklist line.

## What this PR deliberately does not change

- Who merges. Instinct still reviews and merges everything; this PR does not touch branch protection or grant
  anyone merge rights. It's docs + a script + a CI workflow, same category of change as `static-quality.yml`.
- The review bar. The council/CI/Instinct review stays exactly as strict. This only removes the *manual,
  repeated, by-hand* part of re-verifying a scenario that's already been proven once and captured as a test.
- Issue #569 is **not** closed by this PR. The evidence above is reported for Instinct/the owner to confirm and
  close — closing issues is not this PR's or this builder's call.

## Open question for Instinct / the owner

`acceptance-gate.yml` is informational (reports pass/fail) until it's added to GitHub's required-checks list —
there's no branch protection on `main` today (`docs/DECISIONS.md`, 2026-10-26), so nothing currently blocks a
merge on this gate failing. Making it a hard requirement is a repo-settings change outside what a PR can do;
flagging it here rather than changing it unilaterally.
