# Independent evidence verifier (#395)

Status: built as a service with stubbed-fetcher tests (`web/lib/verifier/`, `web/test/evidence-verifier.test.ts`). It is
**not called by any scan, route or tick yet**: wiring it into the lead pipeline (and what a hold does to a lead the
customer sees) is the next increment and a design decision (docs/PROCESS.md "Design items"). Nothing here has run
against a live page or a real lead.

## Why

The pipeline that discovers a lead must not be its own sole judge. The scan's evidence, date, place and contact gates
stay as they are; this service is a second, separately versioned opinion whose verdict cannot depend on the model that
found the lead. It extends the eval work (#394 evaluators, #372 benchmark, #378 actionable rubric): it emits per-lead
verdict records, not a scoreboard.

## Independence

1. **Blinded input** (`claim.ts` `blindClaim`). Only an allowlisted claim is taken: company, domain, place, event date
   and its source URLs, quotes with their URLs, person (name, title, URL), contact (email, URL), requested predicates.
   The producer's model, provider, prompt, rationale, confidence, own verdict, score and any page text or excerpt are
   dropped before any check runs. The record keeps the dropped field *names* only. The same claim from any producer
   hashes the same (`claim_hash`).
2. **Separate retrieval** (`service.ts`). Every cited URL is fetched again by the verifier itself through its own
   `SourceFetcher`. The default is the app's SSRF-safe `fetchPublicHtml`: public hosts only, every redirect
   re-checked, size and time caps. It never reads the scan's cache or `lead_evidence_copies`. Sign-in-walled social
   networks (LinkedIn, Facebook, Instagram, X, TikTok, Threads) are never fetched. A citation to one is unknown.
3. **Own deterministic checks** (`checks.ts`, `text.ts`). No scan extraction, date, place or contact code is reused, so
   a defect in the producer cannot make the verifier agree with it.
4. **Separately configured judge for semantic claims only.** A requested predicate ("is hiring a sales team") is the
   one thing that has no deterministic check. It goes to a `Judge` passed in by the caller. A judge whose model is the
   producer's own model is refused. The judge sees only the company name, the predicate and the verifier's fetched
   text. It must give the same yes/no answer twice within `JUDGE_ATTEMPTS` (3) calls. A timeout, an error, "unclear" or
   a disagreement makes the predicate unknown. **No production judge is configured.** Until one is, every claim with a
   predicate holds.

## Checks (each versioned; `CHECK_VERSIONS`)

| check | pass | fail | unknown |
| --- | --- | --- | --- |
| `claim_well_formed` | every required part present | impossible calendar day | missing part, malformed URL/list |
| `company_on_source` | company named (whole words) on each event source | never named | source unreadable/truncated |
| `domain_bound` | event source is on, names, or links to the company domain | — | none of those: a same-name company can't be ruled out |
| `place_on_source` | claimed city (whole word: Londonderry is not London) on an event source | on none | sources unreadable |
| `event_date_on_source` | date stated next to the company in the page text | after as_of (future); outside window; only the page's publication/update stamp or metadata day; never stated | announced ("will open on…") but not said to have happened; not next to the company |
| `sources_agree` | no event source dates the company's event differently | — | a source dates it, never on the claimed day (a contradiction can't be told from a second event) |
| `independent_confirmation` | first-party source, or ≥2 origins stating the date | — | one origin. Syndicated copies (same URL/canonical, same site, or ≥60% shared 8-word shingles) count as one |
| `quote_on_source` | verbatim (case, quote marks, dashes, whitespace aside) on its cited page | not there | page unreadable/truncated |
| `person_current` | named, title in the same passage, tied to the company, no former marker | not named; "former", "ex-", "until 2025", "left the company"… in the sentence | title or employer not bound |
| `contact_not_recruiting` | not a hiring inbox | `careers@`, `jobs+sales@`, `talent.acquisition@`… (mailbox before any +tag) | — |
| `contact_domain` | on the company's registrable domain | any other domain | — |
| `contact_on_source` | printed on its cited source | not printed | source unreadable |
| `predicate_judged` | judge yes twice | judge no twice | no judge, producer's model, timeout, disagreement, budget |

Aggregation: any fail means `fail`, and the action is **skip**. Otherwise any unknown means `unknown`, and the action is
**hold**. Only an all-pass record is `pass`, with the action **accept**. Unknown is never pass. No action creates a task
for a person.

## Record, budget, log, tenancy

- **Record** (`VerdictRecord`, `record_version` 1, `verifier_version` `evidence-verifier/1`): the blinded claim and its
  hash, as_of, every check result with its version, each source snapshot as the verifier fetched it (visible text
  capped at 100k chars, metadata days, canonical URL, linked domains, sha256 of the body), the provenance groups, judge
  samples, budget used and the verifier's own log. `replayRecord` recomputes the verdict from the record alone, with no
  network and no judge.
- **Store**: `evidence_verdicts` (PG `0050_evidence_verdicts.sql`), tenant-scoped, read only by its own tenant. A run
  is written `running` with its whole per-run cap reserved inside one serializable transaction, before anything is
  fetched. It is then completed once. A completed row can never change (trigger on both engines). Rows are erased with
  their tenant. No retention purge is defined.
- **Budget** (the evaluator's own, never the scan's spend pools, trial budget or model-usage ledger): per run, at most
  8 fetches, 6 judge calls and $0.06. A judge call that reports no cost is charged at $0.01. Per tenant per UTC day,
  500 runs and $2. A refused run is returned as unknown/hold and is not stored. A run whose process dies keeps its
  reservation for that day. These are code constants with per-call overrides; there is no environment setting.
- **Retries**: a fetch is retried once on timeout or transport error (not on non-HTML). A judge gets up to 3 calls per
  predicate. A Postgres serialization conflict on reservation gets up to 4 attempts, then the run holds.

## Not done here (next increments)

- Call the service from the pipeline, for example after a scan marks a lead verified: hold or skip the lead on a
  non-pass verdict, and show the reason. This decides what customers see, so it is a design and owner decision.
- A production `Judge` (which model, provider, key and budget). Until then, predicates hold.
- Register the verifier as an evaluator over eval Worlds (a World-backed `SourceFetcher`), so `npm run evals` reports
  its verdicts next to the replay. That changes the baseline registry.
- A retention period for `evidence_verdicts`. It stores fetched public page text, so it needs an owner decision, like
  the trace retention hold.
