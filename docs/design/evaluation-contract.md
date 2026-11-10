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
`event.predicate` passes only when the right kind of event is evidenced by at least `min_independent_sources` sources on **different registrable domains**. One source, two pages on one domain, or only the company's own site is `unknown`. A contradicting source makes it `contradicted`.

## The evaluator cannot change targeting
The contract is deep-frozen and hashed. `evaluateLead` refuses a contract whose hash is not the one it was frozen with, and edits to a frozen contract throw.

## Denominators
`summarize()` counts unknown and contradicted leads as not validated, and reports `unknown_rate` and `contradicted_rate` as their own numbers.

## Dates
Whole UTC calendar days: the `as_of` day passes, the next day is the future (fails), the window is inclusive, and a date that is not a real day fails.

## Not done here
The evidence collector and the semantic judge (#395, #780-782, #396, #783-785); a live run; a UI for the contract. The domain rule uses the last two labels (three for co.uk-style names) and no public-suffix list.
