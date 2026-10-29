---
name: council
description: Trigger this if the user says 'council', and as the review step of full-stop. Three adversarial reviewer agents on different Claude models review the change in parallel; the author fixes what they rightly find and loops until all three approve.
---

> Vendored from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT, see `../LICENSE-tstack`) and adapted for
> dazl: upstream seats one model from each of three providers; here the council is three DIFFERENT CLAUDE MODELS, the
> subagents in `.claude/agents/`. See `../README.md` for every change from upstream.

# Council

Before the review, address outstanding PR comments, fix known issues, and run the relevant checks. Give the council
the updated implementation; do not hold back known fixes until the reviews return. If the user wants to discard the
implementation and explore new ideas, skip fixes to code being replaced.

## The council

| Seat | Agent (`subagent_type`) | Model |
| --- | --- | --- |
| Reviewer 1 | `reviewer-opus` | opus |
| Reviewer 2 | `reviewer-sonnet` | sonnet |
| Reviewer 3 | `reviewer-haiku` | haiku |

Each is an adversarial, read-only reviewer told to hunt for real bugs, missing negative tests and spec gaps (see the
agent files). Start all three **in parallel**: one `Agent` call per reviewer, in the same message, with
`subagent_type` set to the agent name. If a session started before these agent files existed and does not list them,
start a general-purpose agent with the `model` parameter set to the seat's model and the agent file's body as the
first part of the prompt. If a seat cannot run at all, report it instead of substituting another model.

## The brief

Each reviewer starts with no history. Give each the same brief:

```
Review only. Do not edit, commit, push, comment on PRs, or start subagents.
Repo: <abs path>  Base: <sha>  Head: <sha>
Intent: <1-2 sentences, from the issue or the user's request>
Out of scope: <what this change deliberately does not do>
Checks: <commands you ran and their results>
See: git diff <base>...<head> [-- <paths>]; git status --short (read untracked files).
Read the surrounding code and callers, not just the diff.
```

## Rounds

A full review by all three seats is one round. Then, for each finding:

- **Agree:** make the smallest fix. Prefer deleting or narrowing code over adding locks, caches, helpers or options.
  Add one focused test that fails without the fix when the intent needs it.
- **Disagree:** say why, with evidence (`path:line`, a test, command output).
- **Out of scope or a nit:** decline in one line and list it as a follow-up.

Re-run the checks, then start the next round with the same brief plus a ledger (`fixed:`, `disagree:`, `declined:`
with evidence) and the change since the last round. Ask each seat to mark its earlier ids `resolved` or
`still open: <reason>`.

Stop when all three return `APPROVE` on the current behavior diff with no blocker or should open. Stop as stuck when an
item stays disputed after two replies, or after 3 rounds (5 for security, permissions, auth, data loss or
concurrency): write both sides in 2-3 lines each for Instinct. Running out of rounds is not approval.

Do not let repeated reviews grow the change. It is your job to keep the scope to what the issue asked for.

## Recording the result

Put the result in the PR description. dazl keeps model names out of commits, PRs and PR comments, so use the seat
names:

```markdown
## Council review

Rounds: 2

| Reviewer | Round 1 | Round 2 |
| --- | --- | --- |
| Reviewer 1 | CHANGES 6/10 | APPROVE 9/10 |
| Reviewer 2 | CHANGES 7/10 | APPROVE 9/10 |
| Reviewer 3 | APPROVE 8/10 | APPROVE 9/10 |

Fixed: R1-2 (unreadable play fell back to the global offer), R2-1 (missing negative test). Declined: R3-4 (style).
```

If a reviewer gives no score, write `no score`; never invent one. If the PR is open, edit the description rather
than posting a comment. If there is no PR, put the same result in your reply.
