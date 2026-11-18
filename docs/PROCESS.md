# How dazl gets built (builder + reviewer)

Goal: dazl finds more qualified leads than Gojiberry, measured by the scoreboard, not by claims.

<!-- omh:agent-instructions:begin -->
## Roles

- **Builder (assigned coding agent):** implements one focused issue on a branch, self-checks it, and posts the
  exact head, observed test results and remaining gaps. Never pushes directly to `main`, approves or merges.
- **Reviewer and merger (Hermes only):** independently checks the issue's acceptance, posts the verdict and
  performs the normal protected merge of the exact reviewed head. No second reviewer or council is required.
  If Hermes authored the change, use a fresh independent review context; a same-account COMMENT is not a
  formal GitHub approval and cannot satisfy a required eligible-review rule by itself.
- **Release owner:** deploys the reviewed release and captures revision-bound live evidence. This policy does
  not silently transfer deployment ownership.
- **Owner (Gagan):** sets product decisions and authorization (`docs/DECISIONS.md`).

## The scoreboard is the definition of better

`scoreboard/searches.json` holds fixed searches. `web/scripts/scoreboard.mts` runs them through the real pipeline (TinyFish required; one total budget, SCOREBOARD_MAX_USD_TOTAL, default $3; budget-stopped searches reported INCOMPLETE; results gitignored)
and counts QUALIFIED leads (verified + dated within 90 days + ICP fit >= 4/5 + email or phone), see
`web/lib/scan/scoreboard.ts`. A change that touches lead finding must report scoreboard numbers before and after
(reviewer runs them with the test key). Merge rule: qualified leads go up, or hold for a pure fix.

    cd web && SCOREBOARD_ANTHROPIC_KEY=... TINYFISH_API_KEY=... SCOREBOARD_MAX_USD_TOTAL=3 node --experimental-strip-types scripts/scoreboard.mts

The v1 score does not yet prove buyer need, that the contact is the right decision-maker, or consent (see SCORE_LIMITS).

## Short review and delivery flow

1. **Prove the issue.** Builder pins the acceptance criteria, adds an assertion-failing regression where
   applicable, implements the repair and runs affected tests. Post the exact head, results and remaining gaps.
2. **One Hermes review, then protected merge.** Hermes checks the real callers, the regression and relevant
   positive/refusal controls against that issue; return one actionable list of blocking findings on the same
   PR. Re-review only the repair or relevant base changes, not cleared unchanged code. Unrelated improvements
   go to a follow-up issue. Merge only the exact reviewed head after the existing applicable required checks
   pass; no force/admin bypass or protection edits. A blanket full-suite rerun is not an extra manual review
   step: broader coverage runs when required by existing gates or the change's actual impact.
3. **Deploy, verify, close.** The assigned release owner deploys the eligible artifact and checks the actual
   customer journey. Record the deployed SHA, result and screenshot where applicable; Hermes or the owner
   closes the issue only after live acceptance. A review, merge or passing test alone is not delivery.

Builders repair review findings before taking unrelated work. General builders do not edit `docs/STATUS.md`
or `docs/DECISIONS.md` on their branches; put updates in the PR for Hermes to record after the merge. An
explicit owner-requested documentation change is an exception to the general no-docs branch rule.

## Parallel work (task graph, not a flat queue)

`docs/STATUS.md`'s queues are a dependency graph, not just an ordered list. When more than one queued item is
ready to start:

1. **Don't assume parallel.** An item that explicitly depends on an earlier one (for example #393's own
   targeting → retrieval → contacts → ranking order) stays serial. Only items touching unrelated code paths run
   as independent lanes.
2. **One worktree per independent lane**, each on its own branch, against a shared brief file describing the
   task and an isolated or safely shared test Postgres instance.
3. **Serialize anything that adds a database migration.** Migrations must stay contiguous with no gaps. A lane
   that needs a new migration claims the next number from a single shared counter before starting, not after;
   a second lane needing one waits for the first to land. This is what broke #513 against #564 — two lanes each
   picked a migration number without checking the other.
4. **The same short review applies per lane.** One independent Hermes pass and the existing applicable
   required checks on the exact head. Parallel work never bypasses protection or relevant safety coverage.
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

Use the owner's currently authorized account/provider and allowance. No additional reviewer-model account,
mandatory council or paid fallback is a prerequisite for review. Preserve existing spending caps.

## Policy and safety changes

Respect the recorded evidence, product, privacy and spending decisions. If a change expands authorization,
obtain the owner's decision before implementation. Put necessary design context in the same issue or PR;
there is no mandatory separate design PR or model-approval chain. Hermes checks the relevant safety controls
within the same issue-scoped review.

## Closing issues

A merged PR and a closed issue are not the same thing. Completion means the deployed fix has passed the
issue's live acceptance, with evidence recorded.

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
<!-- omh:agent-instructions:end -->
