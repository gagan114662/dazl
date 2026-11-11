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
- **Clause-level binding:** a sentence counts only when the person is the subject of an employment predicate whose object is the company (at/with/for/from/of). A lawsuit, a negation ("not employed by"), "replaced X, who left", a talk ("is speaking at"), an investment or advisory seat, or a customer relationship is not evidence either way: unknown. A departure cue ANYWHERE in a sentence naming both the person and the company blocks "current" from that sentence (fail closed).
- **Former beats current:** any fresh page with a bound departure (former/ex-/previously X of Company, left/has departed from, who left, resigned from, stepped down from, no longer at/with/for, alumni, until <year>) makes them former, even if another page says current.
- **Current needs a bound, fresh date:** the day must be stated in that very sentence or be the page's own label (a sentence that BEGINS with posted/published/updated/last updated/dated/as of/reviewed and is followed at once by a date), within `max_age_days` of `as_of` (not after it). "We updated our cookie policy on <date>" and unrelated dates elsewhere do not count. Missing, undated or stale is `unknown`, never current.
- **Malformed input fails closed:** a non-array `pages`, null or wrong-type pages, non-string names or a bad `as_of` give `unknown`, never a throw.
- In `contact.usable`: a former employee fails (with or without an email on file); an unrecognised `person` value is unknown (a wrong-case `FORMER` is still a fail); a generic role inbox fails like a hiring inbox; the right domain with an unconfirmed person is unknown; **a confirmed-current person must be tied to the address** (its local part carries their first or last name, via `contact.person_name`), otherwise the confirmation is not about this route and the verdict is unknown; a contact with **no person check at all** is still judged by the route alone, so a lead can reach `validated` without one until the evidence builder (not built yet) always supplies it.
- **Fix round on #1030 (scorer v4):**
  - **Departure blocks current across pages.** A departure cue anywhere in a sentence naming both the person and the company blocks "current" from every page: before the name ("Former Northwind Labs VP Jane Doe"), company first ("Northwind Labs announced that Jane Doe has left"), ex-, outgoing, used to, let go, no longer part of, stepped away, "was ... from 2019 to 2024", "after six years at", "joined Rival from <company>". "Has left the company" also counts on a page that names the company. The result is unknown at best. Only a departure sentence dated clearly older than the window is ignored, because the person may have been rehired. Sentences are no longer split after an abbreviation ("Oct. 20, 2026").
  - **Not employment:** a present participle as the predicate ("is presenting at"), "works with", a consultant, contractor, freelancer or agency (a decision made under delegation), and an event after the company name ("<company> Live").
  - **The sentence's own stated day wins** over the page label.
  - **Person tie** is a whole-token match on the local part (+tag dropped, split on . _ - and digits): first, last, jdoe, janedoe, doej, doejane. Every other token must be an initial or a role word, so janet@, mary.doe@ and jane.smith@ are unknown for Jane Doe.
  - **Generic inbox:** the first token is a role stem (or front/new/main/head + a role), and no later token is the contact's name. Any other suffix (a city, a country code) stays generic. One-word compounds are split into stems (contactus, customerservice, salesteam, infodesk, officemanager, frontoffice, newpatients, mailroom). Practice and booking inboxes (appointments, scheduling, admissions, patients...) are generic too.
  - **Unknown cases:** `person: null` is unknown (only `undefined` means no check). A local part with no letters (`+tag@`, `123@`) is unknown.
  - **Malformed input never throws:** a non-string title, email, name or claimed domain, a malformed result passed to `contactEvidence`, and a malformed `max_age_days` all give unknown.
- **Fix round 2 on #1030 (scorer v5):** current is confirmed only if EVERY in-window or undated sentence naming both the person and the company (or the person and "the company" on a page naming it) itself reads as current; any other such sentence, cued or not, makes the result unknown unless a bound former is found. "Is <word> at" counts only when the word after is/now/currently is an article, a possessive or a title word, so "is out at" is not employment. "Joined <company> as <title>" reads as current. More role inboxes: dispatch, welcome, ask, payroll, email, group, all.
Not done: fetching the pages, matching a person by anything but name and company, and a title check beyond a stated title. The employment patterns are a deterministic list, not exhaustive: an unlisted phrasing is unknown, never current. #781 stays open until the evidence builder always supplies `person`, because until then a contact with no person check is judged by its route alone.

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
