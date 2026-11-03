---
name: sol-loop
description: Use when the user says "sol loop". One review loop with the strongest reviewer agent that is not on the author's own model, until both agree.
---

> Vendored from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT, see `../LICENSE-tstack`) and adapted for
> dazl: upstream loops with OpenAI's GPT Sol; here the reviewer is the strongest Claude reviewer agent in
> `.claude/agents/` that is not the author's model. See `../README.md` for every change from upstream.

# sol-loop

A workflow for making a change more correct before (or after) filing a PR: one reviewer, in a loop, until you both
agree. Make the smallest changes that answer the reviewer. Watch for scope creep and push back when it is right to.

## Pick the reviewer

Strength order: `reviewer-opus` > `reviewer-sonnet` > `reviewer-haiku`. Use the first one whose model is not the
author's (yours):

- author on opus: `reviewer-sonnet`
- author on sonnet or haiku: `reviewer-opus`

Find your model from the harness (in a Claude Code cloud session, `get_session` reports it; otherwise your system
prompt names it). If you cannot tell which model you are, run the `council` instead: it always includes a reviewer
that is not you. Do not substitute another reviewer silently; record which one you used.

## Budget

- Default: 3 rounds. Round 1 is a full review; later rounds check only changed code and open findings.
- Extend to 5 only for security, permissions, auth, data loss or state/concurrency while a blocker or should stays
  open with evidence, or when the user asks.
- Stop early if a round returns only nits. Declined nits and comment, doc or format-only fixes need no new round.
- One reviewer only. It must not start subagents.
- Keep a ledger: id, severity, outcome. Never guess it.

## 1. Scope

Run `git status --short`. Do not stash, discard or include unrelated changes. Find the base after `git fetch origin`:
for a PR, `git merge-base HEAD origin/<base>`; locally, `git merge-base HEAD origin/main`. Use one diff command for
every round. State the intent and what is out of scope in 1-2 sentences. Run the covering checks; do not send code
the change breaks. Note missing or pre-failing checks in the brief.

## 2. Start the reviewer

Start it with the `Agent` tool (`subagent_type` = the agent name). If the session does not list the agent, use a
general-purpose agent with the `model` parameter set to that agent's model and its file's body as the start of the
prompt. Do not edit the scoped files while it runs. A timeout, error or empty reply is not approval.

Round 1 brief:

```
Review only. Do not edit, commit, push, comment on PRs, or start subagents.
Repo: <abs path> Base: <sha> Intent: <intent> Out of scope: <scope> Checks: <results>
See: git diff <base> [-- <paths>]; git status --short (read untracked).
Read surrounding code. Find bugs, broken callers, mismatch with intent, missing negative tests.
Skip style unless it hides a bug. Hold to the smallest change.
```

The agent replies with `VERDICT`, `SCORE` and stable finding ids (see its agent file).

## 3. Answer findings

Check each finding and its severity yourself. Another path, a rare case or a small cost is a nit, whatever its label.

- Agree: smallest fix; prefer deleting or narrowing code. One focused test that fails without the fix, if the intent
  needs it.
- Disagree: say why, with evidence (`path:line`, test, output).
- Out of scope or nit: decline in one line; list it as a follow-up.

Re-run the checks and `git diff --shortstat <base>`. If review grew the diff, cut first. Do not agree just to end the
loop.

## 4. Next round

Start one only if budget remains and a blocker or should is open, behavior code changed, or approval does not cover
the current behavior diff. Send the round 1 brief, the ledger (`fixed:` / `disagree:` / `declined:` with evidence),
the same base diff and the change since the last round. Ask it to mark each old id `resolved` or
`still open: <reason>`.

## 5. Stop

Agreed: `APPROVE` on the current behavior diff, no blocker or should open, no concern of your own. Stuck: an item
stays disputed after two replies, or the budget ends; write both sides in 2-3 lines each for Instinct. Budget end is
not approval.

In the PR description write `Reviewed with sol-loop: <N> rounds, verdict: approved` (no model names in dazl PRs).
Report: rounds, which reviewer agent, what changed because of it, diff size before and after, fixed and declined
findings with reasons. Never merge (see `full-stop`).
