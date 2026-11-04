# DESIGN: Acceptance Contract — catch missing finish-line steps before coding, not after deploying

## The gap this closes

`docs/design/issue-closure-gate.md` (PR #641) fixes issues that are done but never closed. It does not fix the
sharper problem: issues whose definition was never complete enough in the first place, so a builder ships
something that passes its own tests and still misses a step nobody wrote down — discovered only after it's live
(e.g. a flow that needed one more UI change was found only once real use hit it). A test gate can't catch a gap
in the test's own premise. Only writing the premise down first, and having it checked by someone other than the
builder, can.

The 2026-10-30 retro already said this once ("one accountable builder... and one acceptance contract agreed
with Instinct") but it lived in a chat message and wasn't durable. This makes it a required section of the
issue itself.

## The rule

**A builder may not open a branch against an issue until that issue has an `## Acceptance Contract` section,
written by whoever is about to build it, and a comment from Instinct (or the owner, for owner-directed issues)
saying it's agreed.** Template:

```markdown
## Acceptance Contract

1. **User journey** (exact actor, exact steps, starting state): ...
2. **Failure / edge cases this must handle**: ...
3. **Live verification** (the literal command or click-path Instinct — or CI, if it's a sandbox-safe one, see
   below — will run; not "test it works"): ...
4. **Access or spend needed before building** (API keys, sandbox account, budget, DB/table access): ...

Agreed by: <Instinct or owner>, <date>
```

Item 3 is the one this is really about: it has to be the *same* steps the builder tests against during
development, not a new exploration Instinct does cold after merge. If the builder's own proof and Instinct's
live check are different procedures, the gap between them is exactly where things like a missed UI step hide.
Writing it down first also surfaces item 4 (missing access/budget) before a PR is sitting blocked on it, instead
of discovering mid-build that nobody can even run the real check.

## What changes mechanically

- `docs/PROCESS.md` "Flow" step 1 gains a precondition: the top item of `docs/STATUS.md` isn't "ready" for a
  builder until its Acceptance Contract is agreed. An issue without one is `needs contract`, not `next`.
- `.claude/skills/full-stop/SKILL.md` "Prove" step points here: proof must be run against the contract's own
  item 3, and the PR quotes it.
- For issues whose live check already has a safe, sandbox-only, no-production-data path (CRM pushes via
  `scripts/crm-live-acceptance.mts`; this repo will likely grow more of these), item 3 can name a CI job instead
  of a manual Instinct step — see the `crm-sandbox-acceptance` job added to `acceptance-gate.yml` in this PR,
  which runs that exact harness against a free sandbox provider account. It is a no-op until the owner adds a
  sandbox `CRM_ACCEPTANCE_PROVIDER`/`CRM_ACCEPTANCE_KEY` secret (getting a free HubSpot developer-test or
  Pipedrive trial account and token is the one step only the owner/Instinct can take — not something a builder
  session should do unasked). Until that secret exists, the job posts a visible warning rather than failing
  silently, so the gap stays visible instead of looking green.
- Issues that touch real production data, real sends, or real billing have no such CI path and keep Instinct as
  the live checker. This design does not remove that boundary — it only makes what Instinct checks a
  pre-agreed, specific procedure instead of an open-ended audit that then has to go write up a new issue for
  whatever it finds.

## Honest limits

- This does not make Hermes able to close issues without Instinct. Anything touching a live external system
  still needs Instinct's (or a provisioned sandbox CI job's) run — that boundary is a safety rule, not a
  convenience, and this PR does not weaken it.
- This has not yet been proven on a real issue end-to-end. The next step is picking one open issue, writing its
  Acceptance Contract for real, building to it, and getting Instinct's agreement and live confirmation — not
  shipping this template and calling the problem solved.
