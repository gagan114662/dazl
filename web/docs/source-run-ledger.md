# Discovery source-run ledger

`scan_source_runs` records new in-process scan attempts by actual collector ID.
`lead_sources` links stored leads to collectors that produced their surviving evidence.
Both read helpers enforce the job owner's tenant. No old scan is backfilled.

Counters:

- `evidence_count`: actual returned evidence before the shared 40-item cap for public adapters; returned evidence for advanced/complaint collectors. NULL when unmeasured (including model-backed search).
- `candidate_count`: unique company/person plus exact evidence URL submitted by a collector before verification. NULL when candidate conversion was not observed. This is not the raw result count.
- `verified_count` / `review_count`: candidate evidence keys that survived into the final verified/review outcome, after exclusions. NULL when the stage was not observed. Verified means evidence-passed, not necessarily high ICP fit or ready to email.
- `inserted_count`: candidate evidence keys actually inserted by this attempt, verified and review combined. It does not mean new-to-the-tenant companies.

One evidence URL can belong to multiple actual collectors. Their counts overlap and must not be summed into a unique total. A different URL for the same company is not credited when it did not survive. The existing per-lead multi-signal JSON is unchanged.

Attempts are separate. Writes use the existing finish transaction and attempt-ownership guard. Collection errors/timeouts are distinct from measured empty results. Adapter timeout behavior and the model prompt payload are unchanged.

Coverage in this PR: provider search, TinyFish discovery, selected public adapters, advanced returned evidence, and competitor-complaint returned evidence. TinyFish raw search-hit counts are unknown. Advanced disabled/empty/error details remain in connector_audit; this table does not yet copy those zero-result audit rows. SEC/ATS/sitecrawl enrichment, commenter imports, and externally written worker jobs are not instrumented here. The acquisition-mode labels from #119 are separate. Monitor jobs reuse the query runner, so these rows follow their underlying job ID.

No UI, new collection, new permission, sends, or historical counts are added. Message/reply attribution and a yield view are later work.
