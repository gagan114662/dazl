# dazl: notes for Claude Code

**Read `docs/NEVER-AGAIN.md` first, every session:** the mistakes we never repeat, their rules and the gates that enforce them.

<!-- omh:agent-instructions:begin -->
Read `docs/PROCESS.md`, `docs/STATUS.md` and `docs/DECISIONS.md` for roles, the queue and product decisions.

**Hermes is the sole PR reviewer and merger.** Builders (including Quest and Claude Code) implement and
self-check; they do not approve or merge their own work. Deployment stays with the assigned release owner.

Use the short review flow in `docs/PROCESS.md`: issue-scoped regression and affected tests, one independent
Hermes review and protected merge, then deployed live verification. No mandatory council or `full-stop`
pre-review; `full-stop`/`full-send` must stop with the PR open for Hermes and never merge autonomously.

- Report the exact head SHA, observed test results and what remains unverified. Do not repeat cleared reviews
  on unchanged code; review the repair and relevant base changes instead.
- Existing required CI checks, branch protection and security/privacy/spend safeguards still apply.
- Never use closing keywords (`Closes`/`Fixes`/`Resolves #N`): write `Refs #N`. Hermes or the owner closes
  issues only after deployment and live proof (`docs/PROCESS.md`, "Closing issues").
- Vendored skills and reviewer agents may supply evidence; they do not add a second approval chain or replace
  Hermes's independent verdict. Use the owner's currently authorized coding account/provider.
<!-- omh:agent-instructions:end -->
