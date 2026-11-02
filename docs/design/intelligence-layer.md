# Dazl intelligence layer

Status: first vertical under review, not deployed. No lead-yield improvement measured.

## Outcome and boundaries

Make each search use the right seller offer, company identity, event and buyer definitions, and carry explicit corrections into later work. Existing source/date/contact/send gates remain authoritative. A memory is never permission, consent, current employment, deliverability or verified buying intent.

No Oracle migration, new hosted service, model training, paid API, provider probe or autonomous outreach is part of this change. Existing tenant_memory, seller research, scan history, company events and lead evidence stay in place.

## Architecture

1. **Semantic layer**: seller, offer, prospect account, event, person, contact route and decision have distinct meanings (`INTELLIGENCE_ONTOLOGY`). Case-study customers are not the seller, employer history is not current employment, a source publication time is not an event occurrence time, and a published email is not deliverability.
2. **Evidence and memory**: tenant-owned existing evidence stores retain source references and check times. A separate compact seller decision ledger retains explicit authenticated Add/Dismiss actions, not model grades or inferred approval flags. Each row has actor, tenant, job, exact site and offer, hypothesis, version and historical provenance.
3. **Recall**: apply tenant and site scope in SQL before selection. Latest decisions supersede earlier decisions for the same offer/hypothesis. Working recall is bounded by count and bytes and exposes selected/superseded/omitted IDs and historical-proof status. Capacity overflow refuses regeneration rather than silently dropping a restriction. No vector search is needed for this exact-key workload.
4. **Reuse**: deterministic projection into the editable website-research draft, not an instruction prompt. Rejections remove exact matching targeting; confirmations restore explicitly chosen targeting. The flat-field projection currently requires the generated free-text sells value to exactly match one offer name (or one sole offer with no sells value). An edited, descriptive, ambiguous or unmatched offer gets recalled review annotations only, not automatic flat-field correction reuse. This is a deliberate current limitation, not universal correction reuse. Ambiguous offers get no automatic cross-product flat-field merge. Old page quotes are not displayed as proof of a seller edit.
5. **Refinement**: explicit Restore adds a new confirmation; it does not rewrite history. Negative decisions never become positive training. No web page or model output can activate a learned procedure.
6. **Evaluation**: offline multi-run regressions pin scope, rejection replay, projection loss, authorship, rollback, overflow and mixed-store behavior. Production browser regression forwards website/estimate/admission requests to the real handlers on an isolated fixture RPC store, holds runner dispatch and stubs only the site/model transport and authenticated test actor. It exercises Add/Dismiss/Restore, atomic scan admission, unrelated play, recall and editable targeting as one chain. Passing CI and pixel inspection are required before calling this chain proven. Live source-to-qualified yield remains a separate acceptance gate requiring authorized runs.

## First vertical implemented

`ResearchReview` carries explicit Add/Dismiss/Restore events to scan admission. The authenticated route validates event-to-hypothesis bindings and resulting visible profile fields. Decisions are written in the same existing transaction as the scan job before the 3900-character ICP projection can discard research. Read failure or write failure is fail-closed. `/api/scan/icp-from-url` reads the same current SQLite scan store through Db (not a potentially different PG store), obtains scoped recall before generation, and deterministic reuse changes the resulting editable profile. The response includes a content-free recall trace.

Only explicit events from this version are captured. Legacy `icp_inferred=0` or `reviewed` status is not evidence of a person taking an action, so there is no automatic legacy backfill. Source URLs/quotes retained with decisions are client-submitted historical research context, not newly source-verified facts. A deliberate authenticated API request is a targeting preference even if its text is not on a site; it cannot change lead verification.

The ledger is append-only by application contract, with immutable row identity and unique job/offer/hypothesis writes. It does not add SQL UPDATE or DELETE paths. Privacy: tenant isolation on retrieval; no cross-tenant model training; no raw content in recall traces; no automatic retention purge. Data-erasure and full-account deletion must treat this as tenant-owned business data through the separately approved lifecycle workflow. This is not a promise to preserve data against a lawful deletion request. Existing audit/evidence retention rules are unchanged.

## What is not implemented by this slice

- A generalized company/person/event knowledge graph or new canonical entity store. Existing entity/event/provenance work must be integrated, not replaced.
- General AND/OR/NOT and per-clause clocks (#380), current-person/role/contact evidence (#383/#384), canonical entity rejection outcomes (#385), new-event-once semantics (#387), source yield adapters (#388), customer-won learning (#386), multilingual recall (#391).
- Durable per-generation recall trace history (the response currently carries the selection trace), automatic learned-query promotion, source-quality retraining, fine-tuned routers or cached positive qualification.
- End-to-end live improvement or issue closure. No claims that more memory creates new qualified leads.

## Remaining coherent stages

**Account evidence pack**: project existing canonical account/event/contact records into one per-opportunity proof pack with separate freshness clocks and true/false/unknown status. Keep evidence reasons and exact source IDs. First apply as read-only shadow diagnostics; only then gate a changed decision with regression tests.

**Predicate plan**: reviewed typed targeting clauses with AND/OR/NOT, hard constraints versus preferences, per-clause dates and same-account binding. No automatic request widening. Use the evidence pack to show missing proof, not merely a score.

**Outcome loop**: authenticated reasoned feedback at canonical account/person/event scope, explicit reversible exclusions, confirmed CRM outcomes separated from model fit grades, and source/query-to-qualified yield. Immutable outcomes generate reviewed profile proposals, not silent changes to the user's instructions. Hold out negative and unseen examples before enabling a learned strategy.

**Production acceptance**: independent review, exact-head tsc/unit/fixture/browser/real-PG/schema/sql-audit gates, final rebase after 526 lands, then isolated staging and authorized read/write acceptance. Main release 213 stays separate. No source or issue is marked done merely because boot health passes.

## Source grounding and decisions

- Full transcript fetched from https://www.youtube.com/watch?v=1_lX0m64-aI on 2026-11-01. Retain/reuse/recall/refine, ontology/semantic layer, data entitlements and captured traces are the architectural lessons. Demo was not run live; ~99% and 32K versus 200K tokens are the speaker's figures, not independent measurements or dazl targets. Slides/QR demo source not recovered, so no invented finance schema.
- https://finance.biggo.com/podcast/7c3e0455e783ebeb and https://videos.ai-assisted-software-development.com/video/e88dccfa-1cbd-4ddb-b84d-d91659073306 corroborate structure; these are summaries, not additional benchmarks.
- https://github.com/RichmondAlake/memorizz and https://github.com/RichmondAlake/memorizz/blob/main/docs/getting-started/concepts.md: storage is not context; scope before top-k; host owns policy/approval; model repetition is not verified success.
- https://github.com/RichmondAlake/memorizz/blob/main/docs/guides/learning-control-plane.md: immutable events, bounded evidence packs, host-verified outcomes, explicit promotion and reversible suppression. Current docs can be newer than the talk. Ideas applied, implementation not copied; repo reports PolyForm Noncommercial and experimental/not security-hardened.
- https://blogs.oracle.com/developers/oracle-ai-agent-memory-a-governed-unified-memory-core-for-enterprise-ai-agents: vendor description of unified working/semantic/episodic/procedural access patterns, not a reason to replace dazl's database.

Base: 213faf1a, then stacked on exact reviewed 526 `0a43851365f478b10d649136e8ef993ce094d744` solely for gapless 0032/0033/0034 migration integration. No merge or deployment. Final rebase and every exact-head gate required after actual main changes.

Final integration update: rebased onto actual main `0fc9d848121f18f8f8b3449fc4d1e6ce594019bb` after526 merged (parents213faf1a and88a21d54). Migration0034 follows actual0032/0033 gaplessly. Earlier298530a4 chain pixels establish the scenario only; final-head CI/pixels are rerun after this rebase.
