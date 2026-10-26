# How dazl gets built (builder + reviewer)

Goal: dazl finds more qualified leads than Gojiberry, measured by the scoreboard, not by claims.

## Roles

- **Builder (Claude):** writes code on branches, never on `main`. One focused change per branch. Every branch
  message states: what changed, exact claims, what is NOT verified, and how to test it.
- **Reviewer (Instinct):** reads every diff, runs the tests on Linux, runs live scans with the test key, tries to
  break it. Posts findings on the GitHub pull request (or WhatsApp if GitHub is not possible). Approval is required
  to merge (branch protection on `main`). Never pushes, merges or deploys.
- **Owner (gagan):** product decisions only (`docs/DECISIONS.md`), merge and deploy approval.

## The scoreboard is the definition of better

`scoreboard/searches.json` holds fixed searches. `web/scripts/scoreboard.mts` runs them through the real pipeline (TinyFish required; one total budget, SCOREBOARD_MAX_USD_TOTAL, default $3; budget-stopped searches reported INCOMPLETE; results gitignored)
and counts QUALIFIED leads (verified + dated within 90 days + ICP fit >= 4/5 + email or phone), see
`web/lib/scan/scoreboard.ts`. A change that touches lead finding must report scoreboard numbers before and after
(reviewer runs them with the test key). Merge rule: qualified leads go up, or hold for a pure fix.

    cd web && SCOREBOARD_ANTHROPIC_KEY=... TINYFISH_API_KEY=... SCOREBOARD_MAX_USD_TOTAL=3 node --experimental-strip-types scripts/scoreboard.mts

The v1 score does not yet prove buyer need, that the contact is the right decision-maker, or consent (see SCORE_LIMITS).

## Flow (no waiting)

1. Builder takes the top item of `docs/STATUS.md` "Next", works on a branch `b/<topic>`, pushes, asks for review.
2. Builder does NOT wait: it starts the next item on a new branch while review runs. Review findings come first:
   the builder fixes them on the same branch before starting anything new.
3. Reviewer approves on GitHub; owner merges and deploys. `docs/STATUS.md` is updated in every branch.

## Memory

Nothing important lives only in a chat. State is in `docs/STATUS.md`, decisions in `docs/DECISIONS.md`, this
process here. Any agent (new, restarted, or scheduled) reads these three files first.

## Cost

Builder runs on Sonnet for code, Haiku for small chores; Opus only on request. A scheduled cloud builder runs every
4 hours as a backstop and exits early if its last branch still has unresolved review findings.
