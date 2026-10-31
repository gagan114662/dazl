# Same-play source-backed research

Small supplemental record for an existing completed play. It does not reopen the scan, add or reassign leads, or alter scan results. It is not the email-draft outcome required by #349.

## Data effect

One insert into `play_research_sources`, scoped to tenant and existing job. Identical input plus query and offer is deduplicated. No update/delete/promotion endpoint. No production Epoch record is authorized by preparing this code.

Saved context: original query, generated ICP snapshot (not user-approved criteria), original play creation time, effective offer and its source. The original search-window anchor is not reset. Context is rechecked after source fetching and inside the write transaction. Application reads/writes use async Db on both stores. SQLite runs the transaction synchronously; PG uses serializable transactions and context-row locks with bounded serialization retries. No network work occurs inside a transaction. Schema-only startup migration is separate. Changes require reload.

Saved research: supplied company, signal claim, exact quote, source URL and claimed announcement/event date; optional person name, role, professional source URL and exact quote; optional email claim stored separately, never as a recipient. Source and professional checks retain URL, title, retrieval time, page SHA-256 and literal quote result. The page body is not retained. Fetch failure or quote mismatch is visible unconfirmed research, never evidence verification. Current role, company association, fit, timing and buying intent remain unverified.

## Boundaries

The table has no lead ID. Existing leads, outreach, autopilot, export, ranking and qualified counts read no research records. A research ID cannot create a draft. No paid provider, rendering fallback, discovery, contact enrichment or send. The two direct public HTTPS source reads use the existing guarded fetcher. This is not the separate manual source-review job workflow.

Research cards are visible on the original Leads page, outside closed Settings. Quotes/checks and saved play context are collapsible. No approve, draft or send button. Failed save keeps inputs and shows the error.

## Verification

- `test/play-research-db.test.ts`: real SQLite/PG contract for persistence/reload, tenant isolation, duplicate saves, changed offer/missing fallback-row conflicts, finished-job triggers and unchanged original rows.
- `test/play-research.test.ts`: finished-job/lead/outreach preservation, immutable triggers, tenant isolation, pending/unknown job refusal before network, optional professional route separate from email, context races, duplicate save, blocked/thrown fetches and validation.
- `test/play-research-route.test.ts`: actual route malformed/oversized/cross-origin/unknown job input, no writes.
- Existing source-review/play-offer and schema drift tests run with these tests. Real PG parity requires CI's PG service.
- `test/helpers/play-research-original-control.mts`: local scratch proof from a separately supplied read-only original control and earlier fetched source snapshots. It checks original refusal reasons remain unchanged. Not a live production save.
- `test/ui/play-research.ui.mjs`: real component save interaction, all HTTP mocked.
- `test/ui/play-research-page.ui.mjs`: actual LeadsClient plus compiled application styles, saved card and form/error states at desktop and mobile, all HTTP mocked. Uses `RESEARCH_PROOF` from scratch proof; needs esbuild/playwright. No paid call or live writes.

The actual original control remains held: Revnu `lead_not_verified`; Clera `lead_currentness_unconfirmed`. Epoch is source-qualified research, not an app-qualified lead or an email draft. #349 remains open.
