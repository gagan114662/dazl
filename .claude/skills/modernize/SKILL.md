---
name: modernize
description: >-
  For getting old prs up to date. Use when asked to update, rebase or
  "modernize" a pr (in dazl that always means a merge of the base branch, never a rebase).
---

> Vendored from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT, see `../LICENSE-tstack`) and adapted for
> dazl. See `../README.md` for every change from upstream.

# Modernize

Modernize the idea, not just the branch. A clean merge of the base does not prove that
the PR still belongs in the product.

## Guardrails

- Always check to make sure you have pulled latest origin for your branch, main
  branch, and any other branch related to your work before starting.
- Treat existing worktree changes as user-owned. Use a disposable worktree when
  the active worktree is dirty or is being used for other work.
- Modernizing authorizes merging the base branch into the PR branch and pushing it. It does not
  authorize merging the PR, closing it, changing the base branch, or expanding scope.
- In dazl, Instinct reviews exact head SHAs: never rebase, amend, squash or force-push (with or without a lease).
  Bring the base in with a merge commit and push normally, so every earlier head stays in the branch's history.
- Do not post a PR comment unless the user asked for one. Use the
  `leaving-pr-comments` skill for every comment posted on the user's behalf.

## Establish the PR's intent

Resolve the PR and record its URL, state, base, head repository and branch,
current head SHA, author, checks, and review state. Read the title, body, linked
issues, commits, review threads, and complete diff. State the smallest coherent
goal the PR was trying to accomplish before judging its implementation.

Fetch the latest remote base and PR head. Use the PR's actual base branch,
usually `main`, rather than assuming the local branch is current. Record the
merge base so the original PR and subsequent base-branch changes can be
compared separately.

## Check what changed around it

Inspect commits and diffs added to the base branch since the PR diverged. Search
merged and open PRs when titles, code paths, or behavior suggest a replacement
or competing implementation.

Look beyond overlapping lines:

- Has the same user-facing problem already been solved?
- Did APIs, types, schemas, dependencies, or architectural boundaries change?
- Do both sides now claim ownership of the same behavior or invariant?
- Was the code being changed deleted, moved, or intentionally simplified?
- Would landing the PR restore an old behavior or create two ways to do the
  same thing?
- Is the original benefit still large enough to justify the maintenance cost?

Do not describe a PR as current merely because Git reports no conflicts.

## Choose a disposition before pushing

Use one of these recommendations:

- **MODERNIZE**: the goal is still useful and the implementation remains the
  right shape. Merge the base in, resolve conflicts, test, and push the branch.
- **REWORK**: the goal is still useful, but a mechanical update would preserve
  the wrong implementation. Explain the smallest credible rewrite and stop
  before pushing unless the user also asked for that rework.
- **CLOSE**: the PR is superseded, obsolete, directionally wrong, or no longer
  worth its cost. Cite concrete evidence and stop. Do not spend time updating an
  obsolete branch, and do not close it without explicit permission.

Be willing to recommend `CLOSE`. Age alone is not evidence, and sunk effort is
not a reason to keep a PR alive.

## Merge the base without losing intent

For a `MODERNIZE` disposition:

1. Create a safe local branch or disposable worktree at the recorded PR head.
2. Merge the freshly fetched base branch into it (`git merge --no-ff origin/<base>`).
3. Resolve each conflict according to the PR's current intent and the base
   branch's newer invariants. If a conflict reveals a product or architecture
   disagreement, stop and reconsider the disposition instead of guessing.
4. Compare the PR's diff against the base before and after the merge
   (`git diff <old-merge-base> <old-head>` versus `git diff origin/<base>...HEAD`)
   and inspect the final diff. Confirm that no intentional behavior disappeared
   and no already-landed behavior was reintroduced.
5. Run the repository's focused checks for the touched area. Distinguish real
   failures from pre-existing or infrastructure failures.
6. Push normally (a fast-forward). If the push is rejected because the remote
   moved, fetch, merge the new remote head, and reassess; never overwrite it.

Do not merge the PR.

## Report

Lead with `MODERNIZE`, `REWORK`, or `CLOSE` and the reason. Then summarize:

- meaningful changes on the base branch;
- conceptual conflicts or confirmation that none were found;
- the merge and push result, if performed;
- checks run and their results;
- the remaining decision or work, with a link to the PR.

Separate observed facts from judgment. Say what could not be verified instead
of manufacturing confidence.
