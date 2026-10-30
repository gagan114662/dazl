# Claude Code skills for dazl

Every Claude Code session on this repo loads these skills. The reviewer agents they use are in `../agents/`.

**Default flow: `full-stop`.** Prove, review with the `council`, file, babysit CI, then stop with the PR open and
unmerged for Instinct, who is the only one who merges and deploys (`docs/PROCESS.md`).

| Skill | Say | What it does in dazl |
| --- | --- | --- |
| `full-stop` | "full stop" | The default: prove, council review, file, babysit CI, stop for Instinct. Never merges. |
| `full-send` | "full send" | Same as `full-stop` here. It never merges in dazl. |
| `council` | "council" | Three reviewer agents on different Claude models review in parallel; loop until all approve. |
| `sol-loop` | "sol loop" | One review loop with the strongest reviewer agent that is not the author's model. |
| `file-pr` | "file a PR" | A short PR that leads with the problem, plus dazl's claims / not-verified / how-to-test. |
| `babysit-pr` | "babysit" | Watches a PR through CI and review; fixes real findings. Has a fallback for sessions without `gh`. |
| `takeover` | "take over" | Finishes someone else's PR or branch and keeps their credit. |
| `modernize` | "modernize" | Brings an old PR up to date and decides whether it should still exist. |
| `leaving-pr-comments` | (automatic) | Formats comments an agent posts on the user's behalf. |

Reviewer agents (`../agents/`): `reviewer-opus`, `reviewer-sonnet` and `reviewer-haiku`, each an adversarial,
read-only reviewer that hunts for real bugs, missing negative tests and spec gaps, and replies with a verdict, a
score and findings.

## Source and license

Vendored from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) by Theo Browne, MIT license
(`LICENSE-tstack`, kept verbatim), at upstream commit `1085050`. The upstream files were committed unchanged first;
the dazl changes below are a separate commit, so `git log -p -- .claude/skills` shows exactly what differs. The
Codex-only `agents/openai.yaml` interface files were not vendored.

## Changes from upstream

- **No merging.** `full-send` no longer merges; it runs `full-stop`. `full-stop` holds the workflow itself, uses the
  `council` for review, and stops at a "Ready for Instinct" gate. `babysit-pr`, `modernize` and `takeover` never
  merge.
- **Review by Claude models, not other providers.** `council` seats the three reviewer agents instead of one model
  per provider; `sol-loop` uses the strongest reviewer agent that is not the author's model instead of GPT Sol.
- **dazl safety rules win.** A "full stop" request permits local builds, browser automation against a local server
  and screenshots without asking, but never paid scans, live sends, provider or CRM calls, real mailboxes, or
  production data or configuration.
- **No model names in commits, PRs or PR comments** (a dazl rule). `file-pr`, `leaving-pr-comments`, `council` and
  `sol-loop` name the harness or the reviewer seat instead of a model.
- **No history rewrites.** Instinct reviews exact head SHAs, so a pushed branch takes `main` by a merge
  commit, never a rebase, amend, squash or force-push. Every skill says the same (`babysit-pr`, `full-stop`,
  `modernize`, and `pr-wait`'s DIRTY/BEHIND hints).
- **`babysit-pr` without `gh`.** In Claude Code cloud sessions `gh` is installed but not authenticated. `pr-wait`
  now checks `gh auth status` first and exits 2 with a pointer; the skill documents the fallback
  (`subscribe_pr_activity` for wake-ups, the GitHub MCP tools for checks, logs and comments, `git fetch` and the PR's
  checks page when neither exists). `pr-wait` itself still needs an authenticated `gh` and `python3`.
