# The evaluation contract (#394)

**What this is.** The versioned, executable definition of "a good lead", frozen before any run, scored without a human. Code: `web/lib/evals/contract.ts`. Tests: `web/test/evaluation-contract.test.ts`.

**What this is not.** It is not a measurement. No lead has been scored by it on live data, and it calls no network or model. The independent evidence collector (#395, #780-782) is what fills `LeadEvidence`; until it exists, nothing here is a live result.

## The contract (`dazl.evaluation-contract/1`)
`id`, `version`, `as_of` (a real YYYY-MM-DD; the contract never reads the clock), `brief` (seller, offer: context only), and the hard `constraints`:
`places`, `industries` (an empty list must be written to mean "not constrained"), `event_kinds` (at least one), `window_days`, `min_independent_sources` (>= 1), `require_consent`.
A missing or malformed constraint makes the contract **invalid**: `validateContract` lists every problem and `freezeContract` refuses it. Nothing is inferred.

## The verdicts
Per lead, per field: `pass | fail | unknown | contradicted`, with a rationale and evidence pointers. Field ids match the benchmark runner's `CONTRACT_FIELDS`:
`identity.entity`, `source.on_page`, `place.matches`, `industry.matches`, `event.predicate`, `event.date_real`, `event.date_in_window`, `consent.status`, `contact.usable`.
A lead validates only when every scored field passes. Unknown is never pass.

## "High-intent" means independently corroborated
`event.predicate` passes only when the right kind of event is evidenced by at least `min_independent_sources` sources on **different registrable domains** (Public Suffix List including its private section, via `tldts`: `acme.github.io` and `other.github.io` are two companies, as are two `*.vercel.app` sites). One source, two pages on one domain, or only the company's own site is `unknown`. A contradicting source makes it `contradicted`.

## The evaluator cannot change targeting
`freezeContract` deep-freezes the contract, hashes it and registers it. `evaluateLead` accepts ONLY an object `freezeContract` issued: a caller-built `{ contract, hash }` pair is refused even when the hash matches its (altered) contract, and edits to a frozen contract throw.
A version is immutable: the same `id` and `version` always means the same content, so freezing different content under a version already frozen is refused; a change must bump the version. (A process-local registry: the persisted hash lets any later run re-freeze the same content and compare.)

## Denominators and one definition of unknown
`summarize()` counts unknown and contradicted leads as not validated, and reports `unknown_rate` and `contradicted_rate` as their own numbers.
"Unknown" has ONE definition, in `contract.ts` and used by both this summary and the benchmark scorecard: contract fields roll up to the four scorecard fields (the worst verdict wins), and a result is unknown when any scorecard field is unknown, whatever else it did. A lead that fails one field and is unknown on another counts as unknown (so `failed` and `unknown` can overlap).

## Auditability
The benchmark runner persists the frozen contract hash in every judgement's record. A scorer that returns no hash is not trusted: that result is unknown with the reason recorded.

## Dates
Whole UTC calendar days: the `as_of` day passes, the next day is the future (fails), the window is inclusive, and a date that is not a real day fails.

## Person and contact-route verification (#781)
`lib/evals/person-verify.ts` decides from pages somebody else fetched whether the named contact is CURRENT at the company, and hands the contract `contact.person` (`current | former | unknown`).
- **Clause-level binding:** a sentence counts only when the person is the subject of an employment predicate whose object is the company (at/with/for/from). A lawsuit, a negation ("not employed by"), "replaced X, who left", or a former role at a DIFFERENT company is not evidence either way: unknown.
- **Former beats current:** any fresh page with a bound departure (former, left, resigned from, stepped down from, no longer works at, alumni, until <year>) makes them former.
- **Current needs a bound, fresh date:** the day must be stated in that very sentence or be the page's own labelled posted/published/updated/dated date, within `max_age_days` of `as_of` (not after it). An unrelated date elsewhere on the page does not count. Missing, undated or stale is `unknown`, never current.
- In `contact.usable`: a former employee fails (with or without an email on file); a generic role inbox (info@, sales@, webmaster@, reception@, and the same with a team or region qualifier, e.g. sales-emea@, info2@) fails like a hiring inbox; the right domain with an unconfirmed person is unknown; a contact with no person check is judged by the route alone.
- The scorer version is now 2: these verdicts differ from version 1 for the same frozen contract and evidence, so persisted judgements can tell the algorithms apart.
Not done: fetching the pages, matching a person by anything but name and company, and a title check beyond a stated title. The employment patterns are a deterministic list, not exhaustive: an unlisted phrasing is unknown, never current.

## Not done here
The evidence collector and the semantic judge (#395, #780-782, #396, #783-785); a live run; a UI for the contract. Contracts are frozen per process; a durable contract store is not built.
