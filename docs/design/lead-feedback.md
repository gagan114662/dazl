# Lead feedback: reasoned rejections that later runs honour (#385)

`web/lib/scan/feedback.ts` records a tenant's verdict on one of its leads in `lead_feedback`. The table is tenant-scoped,
with the SQLite DDL in `lib/scan/feedback-tables.ts` and the Postgres migration in `0018_lead_feedback.sql`.

Each verdict is stored at the level its reason names:

| reason | level | what later runs do |
| --- | --- | --- |
| wrong industry, wrong location, competitor, existing relationship, not useful | account | the company is dropped |
| wrong person | person | that person and contact are stripped; the company can come with someone else |
| wrong timing | event | the same event, an older one, or an undated one is dropped; a **newer** dated event passes (the "new relevant event" policy) |

**Applied before verification.** The runner reads the tenant's active rejections from the scan's own store. It applies them
to every candidate list before the verifier: the main pass, the news fallback, the dated-coverage recovery and the CSV
company path. Each drop is recorded in the run report's candidate audit as `previously_rejected:<reason>:<feedback id>`,
so a missing company is explained.

**Ranking.** A rejected lead never trains the lookalike reference cohort, whatever its fit grade. An opted-out (suppressed)
contact never does either, as before.

**Explainable and reversible.** `explainEntity` lists the feedback that applies to a company, and `resetFeedback` reverses
one verdict and keeps its reason. Every read and write takes the tenant, so another tenant's lead or feedback id is unknown.

**Hard rules apart from learned preferences.** Rejections are explicit rules and are applied. What the verdicts suggest is
only reported:
- `sourceYield`: accepted and rejected counts per source host;
- `proposeProfile`: competitors and existing relationships proposed as named memory exclusions.

A proposal is computed against the memory version it saw. `applyProposal` writes it only when the tenant applies it, and
refuses it once memory has changed since.

**Keys, until #364.** Until the canonical account graph exists, an account is matched by its company key (case and legal
suffixes aside) or its domain, and a person by contact address or name. Splitting same-name unrelated businesses is #364's
job, and this store is built to point at its canonical ids then.

**Not built:**
- the route and the button on the lead card that record a verdict (this lands the model and its enforcement);
- source yield feeding query planning.
