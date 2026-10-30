---
name: babysit-pr
description: Monitor a pull request through review and CI. Use when the user asks to monitor, watch, or babysit a PR.
---

> Vendored from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT, see `../LICENSE-tstack`) and adapted for
> dazl. See `../README.md` for every change from upstream.

# Babysit PR

Many repos have AI review bots. They're helpful, even if they are not always
right.

## Waiting

**In dazl's Claude Code cloud sessions, read "Cloud sessions without `gh`" below first:** `gh` is installed there but
not authenticated, so `pr-wait` cannot run.

Never write your own watcher, polling loop, or `sleep` loop. Use one watcher
per PR: `watch_pull_request` in T3 Code, `pr-wait` everywhere else. Never run
both on the same PR. Every watcher on a GitHub account shares one rate limit.

### In T3 Code: `watch_pull_request`

Handle the existing checks and comments first. Then call
`watch_pull_request` and end your turn. T3 Code wakes you with a message when
a check fails, the required checks pass, someone comments or reviews, or the
branch conflicts.

- **Only the thread that owns the PR watches it.** If you are a delegated
  child task (a reviewer, a Sol round, any `delegate_task` child), never call
  `watch_pull_request`. The parent owns the PR. Do not watch PRs you are not
  working on.
- **A wake is news, not a merge decision.** Check the merge gate yourself.
- **Unwatch when you hand off.** A watched thread stays in Working and out of
  the user's inbox. When you stop (ready, blocked, or asking the user a question),
  call `unwatch_pull_request` first. A merge or close ends the watch on its
  own.
- **"Stopped watching, could not read it"** usually means GitHub's rate limit
  is used up. Run `gh api rate_limit --jq .resources.graphql` before you
  watch again. If `remaining` is near 0, wait for `reset` with one background
  command, then watch again. Never watch again in a tight loop.

### Everywhere else: `pr-wait`

Wait with `scripts/pr-wait` from this skill's directory (use its absolute
path).

```bash
pr-wait <pr> [--repo owner/name] [--until ready|green|any-change]
```

It prints one line per real event. It exits 0 when the `--until` condition is
met or the PR merges, 1 when it needs you (a required check failed, conflicts,
unresolved threads, PR closed), and 2 on bad input.

- `ready` (default): required checks green, Greptile or Macroscope reviewed the
  head, and no unresolved threads. Use this to babysit.
- `green`: required checks only. Use it when the repo has no Greptile or
  Macroscope.
- `any-change`: exit on the first event.

In Claude Code, run it with the Monitor tool (`timeout_ms: 3600000`), so each
line wakes you. Without a monitor, run it as one long command. It ends on its
own.

Start it again after you push, after you handle an exit 1, and after a resume.
It remembers what it already reported, so nothing that arrived in between is
lost. If it says another pid already watches the PR, do not start a second one.
Kill the old one only if its events do not reach you.

With either watcher: when an event needs no action, end your turn without a
message. Never post or say "still waiting".

### Cloud sessions without `gh` (dazl builders)

Check once with `gh auth status`. When it fails (the usual case in Claude Code on the web), `pr-wait` exits at once
with a pointer here. Use the session's own GitHub tools instead; do not try to authenticate `gh` or copy a token:

- **Wake-ups:** call `subscribe_pr_activity` for the PR (claude-code-remote tools). CI results, reviews, comments and
  the merge or close arrive as events that wake the session, so there is nothing to poll. Keep one safety-net
  check-in with `send_later` (about 50 minutes after the last activity) for what events miss: merge conflicts and
  pushes by others.
- **Reading state:** the GitHub MCP tools. `pull_request_read` with `get_check_runs` (CI on the head), `get_status`,
  `get_comments`, `get_reviews` and `get_review_comments`; `get_job_logs` for a failed job's log; `pull_request_read`
  `get` for mergeability.
- **Replying:** `add_issue_comment` or `add_reply_to_pull_request_comment`, formatted with `leaving-pr-comments`.
- **Neither available:** `git fetch origin <branch>` shows pushes, and the PR's checks page
  (`https://github.com/<owner>/<repo>/pull/<n>/checks`) shows CI. Tell the user plainly that you cannot watch the PR,
  and what they will need to check.

Never use Bash `sleep` loops in place of any of these.

## GitHub rate limits

`gh pr create`, `gh pr view`, and `gh pr checks` use GraphQL. When GraphQL is
used up, the REST limit is separate and usually still has room. Use
`gh api repos/<owner>/<repo>/pulls/<n>` to read a PR, and
`gh api repos/<owner>/<repo>/commits/<sha>/check-runs` for checks.

## Reviews

Only act on checks and comments newer than the latest push. Verify every bot
finding against the source before changing code. Fix real findings and CI
failures, distinguish repository failures from infrastructure flakes, and reply
with a written reason when dismissing false positives.

If the repo has `.macroscope/check-run-agents/*.md`, read those rules before you
reply to a Macroscope finding. Its findings cite them.

CodeRabbit is advisory. Treat its findings like any other finding, but never
wait for it and never hold a merge for it.

If a review bot leaves feedback you believe is not worth addressing, reply with
a written reason and resolve the comment. Use the `leaving-pr-comments` skill
for every comment posted on the user's behalf.

Screenshots and videos help as well, when you have a way to upload them.

Keep the PR at the size the user's goal needs. Review loops tend to grow a
PR one cheap-looking fix at a time. Fix real bugs in the intended case.
Decline the rest with a written reason, and list them as follow-ups:
unneeded tests, guards for edge cases that do not matter, extra integration
or compatibility, and small performance costs. Prefer the fix that deletes or
narrows code.

## Base branch and merging

Keep an eye on changes to `main` and merge it into the branch when needed (a merge commit; never rebase,
rewrite history or force-push, since Instinct reviews exact head SHAs). `pr-wait` reports when
new base commits touch this PR's files, and when the PR becomes BEHIND or DIRTY.
`watch_pull_request` reports conflicts only, so check for BEHIND yourself
before you call the PR ready.
If an overlapping PR makes this one obsolete, stop monitoring, report it to the
user, and ask before closing the PR unless closure was explicitly authorized.

If nothing has changed, stay quiet rather than posting filler comments. Stop
when `pr-wait` exits 0, or when the "Ready for Instinct" gate in `full-stop` passes on the latest head.

**Never merge in dazl,** even when asked to "full send": Instinct is the only one who merges (`docs/PROCESS.md`).
Report that the PR is ready, with its exact head SHA. When the branch is BEHIND or DIRTY, or base commits that
landed after the last green run touch this PR's files, bring `main` in with a merge commit (never rewrite a branch
someone has reviewed), push, and wait for green again.

In dazl, Instinct's review comments are the gate: answer every HOLD on the PR with what changed and the new head
SHA. Bot comments that only say a reviewer bot is out of credits need no reply.
