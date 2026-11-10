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

## The separate semantic judge (#782)
`lib/evals/semantic-judge.ts` is orchestration around INJECTED judges (a real model judge is one `Judge` function plugged in later; this file calls no model or network).
- **Blinded:** the judge reads the claim through the runner's `blindItem`: no system, product, model or config, identity tokens scrubbed; a judge cannot change the claim the next judge sees.
- **Unknown on timeout or disagreement:** a call that times out or throws is retried up to `max_attempts` in all, then held as unknown (the abort signal is raised on timeout). At least 2 separately configured judges must give the same pass/fail; a difference, or any judge that is unknown, makes the claim unknown. One judge alone is unknown.
- **Separate budget and log:** the judge spends its own call budget (never the producer's); when it is spent the claim is unknown. Every call is logged on the judge's own log with attempt, outcome and elapsed time.
- **Provenance dependency:** sources that copy one another are one source: a declared `syndicated_from`, or overlapping text (at least 80% of the shorter text's word 5-grams appear in the other, shorter text of 4+ words, so a dateline, byline or footer does not hide a reprint), joins the group of the original. `independentSources` counts groups on distinct registrable domains. Malformed sources are dropped, not thrown on. **Not wired yet:** `independentSources` is not called from the contract's `event.predicate`, so the contract still counts raw domains and this rule changes no verdict today (disclosed by Hermes-PC's review).
- **Spend gate fails closed:** a judge budget (`max_calls`, `used`), `max_attempts`, `timeout_ms` or `log` that is missing, not a finite whole number in range, or NaN makes `judgeClaim` return unknown with NO judge called. Two names for the same judge function are one judge (unknown). `now` must be a function and `timeout_ms` at most 2147483647 (the timer clamps larger values to about 1 ms and would burn the budget); a missing claim or non-string identity tokens return unknown before any call. A judge that rejects with a non-Error (undefined, null, a string) is logged as an error and held unknown. Limit: duplicate detection is by function reference; a real model judge must carry a provider+model descriptor and duplicates of it must be rejected.
Not done: a real model judge, the calibration gate against adversarial fixtures (#783-785), and feeding `independentSources` into `event.predicate`.

## Not done here
The evidence collector and the semantic judge (#395, #780-782, #396, #783-785); a live run; a UI for the contract. Contracts are frozen per process; a durable contract store is not built.
