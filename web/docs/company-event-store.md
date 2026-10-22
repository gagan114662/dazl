# Company event store

Foundation for account-level signal history: one observed company-level event per row,
tenant-isolated, with mandatory provenance and natural dedup. Market signals (hiring,
funding, competitor mentions) and customer/account signals (events tied to one of the
tenant's own leads/accounts) share the table and are separated by `scope`.

## Principles

- **Tenant isolation.** Every row carries `tenant_id`; reads are tenant-scoped only. No
  shared or pooled event data across tenants, ever.
- **Provenance is required.** A row cannot exist without `source_url` (http/https, <= 500
  chars) and `retrieved_at` (when dazl fetched it). `source_published_at` is the date the
  source itself states, when it states one.
- **Unknowns stay NULL.** No inferred published dates, no guessed people, no assumed
  companies. `company_key` is the domain when known, else a normalized name, else the
  event is not recorded.
- **Dedup by natural key.** `(tenant_id, company_key, event_type, source_url)` is unique.
  Re-observing the same fact from the same source refreshes `last_seen_at`/`retrieved_at`
  instead of duplicating; `first_seen_at` is preserved.
- **Freshness is derived.** `FRESHNESS_DAYS` per event type (funding_round 548d,
  hiring_surge 30d, tech_stack 90d, competitor_mention 30d) applied at read time. No
  stored staleness flags to drift.
- **No causal attribution.** Events describe what a source said and when we saw it. They
  never claim a deal, reply, or revenue resulted from a signal.
- **No backfills.** The store accrues events from new collector runs only.

## What does NOT go in this store

- Person-level signals (champion job change, new CRO). A `people_change` event type is a
  possible future addition sourced only from verifiable public company announcements; it
  is deliberately not in this slice and no person data is collected for it.
- First-party website intent (page visits, identified visitors). Design-only until a
  separate privacy/data-collection decision. No `website_intent` type exists in code.
- Raw HTML/page diffs. Tech-stack change detection is a distinct future feature that
  diffs consecutive crawl results per company; it is not a page-diff dump and is not
  conflated with competitor HTML diffing.

## Ingest adapters (existing collectors only)

First adapter: `enrichJobSignals` in `web/lib/signals/index.ts` (SEC EDGAR funding +
Greenhouse/Lever/Ashby hiring + funding-round news). It already writes
`lead_enrichments` with source URL + date per tenant; it now also records
`company_events` rows with `scope='account'` and the lead's company key. No new
collection, no new fetch, no new permissions.

Documented future adapters, not built: `watch.ts` weekly watch hits -> `scope='market'`
competitor_mention events; consecutive `connectors/techstack.ts` crawl results ->
tech_stack change events (requires crawl history diffing, its own slice).

## Schema

See `web/lib/events/store.ts` (`migrateEvents`). `recordCompanyEvent` returns whether a
new row was created; `listCompanyEvents` is tenant-scoped with optional company/scope/
freshOnly filters and computes `fresh` at read time.
