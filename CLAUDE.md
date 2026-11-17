# dazl: notes for Claude Code

**Read `docs/NEVER-AGAIN.md` first, every session:** the mistakes we never repeat, their rules and the gates that enforce them.

Read `docs/PROCESS.md`, `docs/STATUS.md` and `docs/DECISIONS.md` first: roles, the current queue and the product
decisions. Instinct reviews every change and is the only one who merges and deploys.

Before reporting a PR as ready, run full-stop (council review with the opus/sonnet/haiku reviewers + babysit CI).

- **Default flow: `full-stop`** (`.claude/skills/full-stop`): prove, review with the `council`, file, babysit CI, then
  stop with the PR open and unmerged for Instinct. `full-send` never merges in this repo; it runs the same flow.
- Skills are in `.claude/skills` (vendored from t3dotgg/tstack, MIT; changes listed in its `README.md`). The
  reviewer agents are in `.claude/agents`.
- Report every PR with its exact head SHA, the test commands and their output, and what is not verified.
- Never use a closing keyword (`Closes`/`Fixes`/`Resolves #N`): write `Refs #N`. Instinct or the owner closes
  issues after deploy + live proof (`docs/PROCESS.md` § "Closing issues").
