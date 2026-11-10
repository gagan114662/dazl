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

## Not done here
The evidence collector and the semantic judge (#395, #780-782, #396, #783-785); a live run; a UI for the contract. Contracts are frozen per process; a durable contract store is not built.
