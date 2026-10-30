---
name: full-send
description: Trigger this if the user says 'full send'. In dazl this does NOT merge - it runs the full-stop flow and stops for Instinct.
---

> Vendored from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT, see `../LICENSE-tstack`) and adapted for
> dazl. See `../README.md` for every change from upstream.

# Full Send (dazl: same as full-stop, never merges)

Upstream, "full send" takes a change all the way to a merged PR. **In dazl it must not merge:** Instinct is the only
one who merges and deploys (`docs/PROCESS.md`), and nobody else may merge, enable auto-merge, push to `main` or bypass
review on anyone's behalf.

So treat "full send" exactly as "full stop": read the [full-stop](../full-stop/SKILL.md) skill and follow it (prove,
council review, file, babysit CI, then stop with the PR open and unmerged for Instinct). Its proof permissions and
dazl safety rules apply unchanged. Tell the user in your report that the PR is waiting for Instinct, not merged.
