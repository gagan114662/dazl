# Lead feedback: reasoned rejections and outcomes that later runs honour (#385)

`web/lib/scan/feedback.ts` stores a tenant's explicit verdict on one of its leads in `lead_feedback` (SQLite DDL in the
same module, Postgres `0044_lead_feedback.sql`). Every read and write takes the tenant.

## Capture

| reason | level | what later runs do |
| --- | --- | --- |
| wrong industry, wrong location, competitor, existing relationship, not useful | account | the company is dropped |
| wrong person | person | that person (name and address) is stripped; the company can come with someone else |
| wrong timing | event | the same day, an older day, a mirror of it on another URL, and an undated event are dropped; a strictly **later** event day passes (the "new relevant event" policy) |

- **Where.** Reject on a lead card offers these reasons (wrong person only when the lead names a person, wrong timing only
  when it has a dated event). `POST /api/leads/[lead]/quarantine` with `feedback_reason` quarantines the lead and records
  the verdict in ONE transaction, after validating everything (a bad reason, a wrong-person rejection with no person, a
  wrong-timing rejection with no date: 400, nothing quarantined, nothing recorded). A reject with free text only, or with
  no reason, quarantines and teaches nothing: hiding is not a reasoned label.
- **Accept** is its own explicit call (`POST /api/leads/[lead]/feedback {verdict: 'accept'}`). Approving a draft is not an
  acceptance; an opted-out contact is never a positive.
- **Versioned.** Each verdict takes the tenant's next `version` (`(tenant_id, version)` is unique; a lost race on Postgres
  retries).
- **Reversible and explainable.** Undo (`DELETE /quarantine`) resets the verdicts that lead wrote; `DELETE
  /api/leads/[lead]/feedback {id, reason}` resets one; the rows stay with `reset_at` / `reset_reason`. `GET
  /api/leads/[lead]/feedback` lists every verdict that applies to the lead's account.

## Enforcement in a run (hard rules)

`feedbackGate` in `lib/scan/runner.ts` reads the tenant's active rejections once per run (all of them: no row cap) at the
first verification:
- before each verifier pass (main, news fallback, stale retry, CSV company job): a rejected company costs no fetch;
- after the verifier, on what it kept, and on the login-walled / self-description rows added outside it (a contact the
  verifier read off the page can be a rejected person);
- after enrichment (`stripRejectedPeople`): a rejected person the crawl or the people search added again is removed.

Each drop is in the run report's candidate audit as `previously_rejected:<reason>:<feedback id>` and counted in
`drop_reasons.previously_rejected`. **Fail closed:** a store that exists but cannot be read drops every candidate as
`feedback_unreadable`; a missing table (an older store) means nothing was ever recorded.

**Keys until #364.** An account matches by domain when both sides name one (a same-name business on another domain is
someone else), otherwise by company key (case and legal suffixes aside); a candidate without a domain is matched by name,
which may hold a same-name business (fail closed). A person matches by name or address at the same account.

## Learned preferences (ordering and proposals only)

- **Ranking.** `learnedPreference` gives -1 / 0 / +1 per lead from the tenant's explicit verdicts on the same source host
  AND signal kind (at least 3 verdicts; >= 60% accepted +1, <= 20% accepted -1). `rankLeads` uses it inside a fit lane,
  before event evidence; it never outranks fit, changes a grade or relaxes a gate. The leads API returns it as `learned`
  with its reason. It is a filter on the tenant's own past choices, not a prediction of buying.
- **Lookalike cohort.** Explicit accepts join it; any rejected lead or account leaves it whatever its grade; an opted-out
  contact never joins; an unreadable store gives no cohort.
- **Profile proposal.** `GET /api/settings/feedback` proposes competitor / existing-relationship rejections as named memory
  exclusions (domain when known) against the memory and feedback versions it saw; `POST` applies it only while both are
  unchanged. Nothing changes memory by itself.

## Not built

- Instrumenting the actual handoff (email / call / other contact attempt) separately from save/hide, and acting-user
  grades apart from researcher evidence (owner acceptance of 2026-11-01).
- Calibration per seller offer (it is per source host and signal kind only).
- Source yield feeding query planning (it orders leads only).
- A UI for accept, explain, reset and the profile proposal (API only; Reject reasons and Undo are in the UI).
- Retroactive holds: a lead kept in an earlier play is not re-hidden when a later rejection names its account.
