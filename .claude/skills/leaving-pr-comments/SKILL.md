---
name: leaving-pr-comments
description: Use whenever leaving comments on GitHub.
---

> Vendored from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT, see `../LICENSE-tstack`) and adapted for
> dazl. See `../README.md` for every change from upstream.

# Leaving PR Comments

Prefix every agent-authored comment left on the user's behalf with this GitHub
note callout:

```md
> [!NOTE]
> 🤖 **Claude Code responding on behalf of <user>**

Actual comment starts here.
```

Name the harness (Claude Code), never a model: dazl keeps model identifiers out of commits, PRs and PR comments. Use
the user's name or GitHub login.

When the harness or session requires its own attribution footer on GitHub posts (Claude Code on the web does), keep
that footer too: harness rules win over the "no signature footer" rule below.

Before posting, check the entire comment, including quoted text and
attachments, for secrets and private details.

Keep the attribution inside the note and the actual reply outside it. The
context line must start with the robot emoji. Do not add a horizontal rule,
Setext underline, heading, signature footer, or a second attribution.

Apply this format to top-level PR comments, inline review comments, replies to
bots or reviewers, and written explanations used before resolving or
dismissing feedback. Do not add it to PR descriptions, commit messages, or text
the user explicitly asked to post verbatim without attribution.

Write the comment itself in a direct style:

- Lead with the conclusion.
- Cite the relevant code, behavior, check, or reproduction.
- Keep it concise and avoid filler, canned thanks, or status narration.
- Distinguish verified facts from judgment.

Preview the final Markdown before posting so quoting and blank lines render as
shown. After posting, verify that GitHub returned the comment or review URL.
Resolve a review thread only after its response was posted successfully.
