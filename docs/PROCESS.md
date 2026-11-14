# How dazl gets built (builder + reviewer)

Goal: dazl finds more qualified leads than Gojiberry, measured by the scoreboard, not by claims.

## Roles

- **Builder (Claude):** writes code on branches, never on `main`. One focused change per branch. Every branch
  message states: what changed, exact claims, what is NOT verified, and how to test it.
- **Reviewer (Instinct):** reads every diff, runs the tests on Linux, runs live scans with the test key, tries to
  break it. Posts findings on the GitHub pull request (or WhatsApp if GitHub is not possible). Instinct decides:
  her review is the merge gate (there is no GitHub branch rule on `main` since 2026-10-26; the gate is this
  process), and Instinct merges. The builder's work is done
  when Instinct is satisfied, not when the builder says so.
- **Owner (gagan):** product decisions (`docs/DECISIONS.md`). Has given Instinct merge rights.

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
3. Hermes-PC reviews and merges on GitHub. **Branches must not edit `docs/`** — no `docs/STATUS.md`,
   no `docs/DECISIONS.md`. Builders put their STATUS line and any decision text in a PR comment; Hermes
   writes `docs/STATUS.md` and `docs/DECISIONS.md` on `main` after the merge. (2026-11-13: every branch
   appending to STATUS.md re-conflicted every other branch, costing ~90 min of CI per re-merge.)

## Parallel work (task graph, not a flat queue)

`docs/STATUS.md`'s queues are a dependency graph, not just an ordered list. When more than one queued item is
ready to start:

1. **Don't assume parallel.** An item that explicitly depends on an earlier one (for example #393's own
   targeting → retrieval → contacts → ranking order) stays serial. Only items touching unrelated code paths run
   as independent lanes.
2. **One worktree per independent lane**, each on its own branch, against a shared brief file describing the
   task and a shared test Postgres instance. This is the pattern that already worked on 2026-10-31 (one agent
   per PR in its own worktree; a PR landed ~8 minutes after handoff with council + probe still run in full).
3. **Serialize anything that adds a database migration.** Migrations must stay contiguous with no gaps. A lane
   that needs a new migration claims the next number from a single shared counter before starting, not after;
   a second lane needing one waits for the first to land. This is what broke #513 against #564 — two lanes each
   picked a migration number without checking the other.
4. **The verify gate stays full, per lane.** Council review and CI green on the exact head, same as any other
   change. Parallel lanes never skip or shorten review to go faster.
5. **Show the graph, not just the queue.** When `docs/STATUS.md` is updated, state which items are running in
   parallel right now, which are blocked on what, and which are serialized behind a migration claim — not only
   a flat ordered list.
6. **Post progress per lane, immediately.** A PR comment and a WhatsApp line the moment each lane's work pushes,
   not after the whole batch finishes. More parallel lanes means more surface area for a crash to lose state
   silently (see the 2026-10-31 14:15 EDT crash, where 7 pushed heads sat without a comment or message).

## Memory

Nothing important lives only in a chat. State is in `docs/STATUS.md`, decisions in `docs/DECISIONS.md`, this
process here. Any agent (new, restarted, or scheduled) reads these three files first.

## Cost

Builder runs on Sonnet for code, Haiku for small chores; Opus only on request. A scheduled cloud builder runs every
4 hours as a backstop and exits early if its last branch still has unresolved review findings.

## Design items (not built by the scheduled builder)

Changes to the evidence verifier, grading/scoring rules, product policy, spend guards or privacy are design items.
The scheduled builder (Sonnet) writes a design note in `docs/design/<topic>.md`, opens a "DESIGN:" PR, marks the item
"needs design" in STATUS.md and moves on. An interactive session (Opus) or the owner decides and implements;
Instinct reviews as usual.

## Closing issues

A merged PR and a closed issue are not the same thing, and only the second one counts (see "done means Instinct's
visible final acceptance", 2026-10-30).

- **Builders never use GitHub closing keywords** (`Closes`/`Fixes`/`Resolves #N`) in a PR body or a commit
  message. They write `Refs #N`. An issue closes only after the fix is deployed and verified live (owner comment
  on #569, 2026-11-02, after a PR body auto-closed it from an offline pin). The reviewer or the owner closes it,
  and the issue/PR records the live evidence: the deployed commit, the real-provider or real-user-journey result,
  and the cleanup. `acceptance-gate.yml` job `no-closing-keywords` fails any PR that has a closing keyword.
- **A passing tagged test is necessary evidence, never sufficient.** A test is tagged `#N` when its own
  `test()`/`it()` name contains `#N` (see `test/crm-contract.test.ts`'s `#569 repro`). `node web/scripts/gate-check.mjs
  <N>` prints `GATE #N: PASS` only if at least one tagged test executed (not skipped, not todo) and everything in
  the files it ran passed, with the executed/skipped counts. CI job `tagged-tests` runs it for each `Refs #N` that
  has a tagged test, and is skipped otherwise. It never closes anything and is not a live check.
- **An issue with 3+ merged PRs against it and no close gets a tracked checklist before another PR opens
  against it.** The next builder to touch it edits the issue body into an explicit `- [ ]` list of the specific
  remaining acceptance criteria (not "more work needed"), so partial PRs can check boxes instead of silently
  accumulating. See `docs/design/issue-closure-gate.md` for the audit that motivated this.
