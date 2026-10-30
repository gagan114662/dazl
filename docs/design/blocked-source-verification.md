# Verifying against text TinyFish already fetched when dazl's own fetch is blocked

Status: the NARROW public/readable-source path below is implemented on this branch (isolated fixtures only). It is NOT proof of
better live yield: no live scan has been run, and nobody knows yet how often it changes a real outcome. Walled social sources and
any wider use are separate scope and are not approved.

## Problem

The 2026-10-26 live NYC acceptance run (#204) produced one candidate, a Facebook group post, stored in review as `blocked_by_site`
because dazl's own fetch of the page was refused. Earlier isolated runs had 5 of 6 candidates blocked by their sites. A blocked
candidate can never become verified. TinyFish fetch (up to 16 pages per scan) already returns page text for extraction; that text
used to be discarded and the verifier fetched the page again by itself.

## What is built (code: `web/lib/scan/held-text.ts`, `verifyLeads` in `runner.ts`)

When dazl's own fetch of a candidate's `source_url` fails with `blocked_by_site` or `needs_javascript` AND TinyFish already returned
text for exactly that URL in this scan attempt, the same checks run on that text: verbatim quote (existing normalised match), company
named in the quote or title, closed-posting check, counterparty check, event-date rules, confidence floor, then the existing window
gate and every identity/outreach gate downstream. A copy can only PROMOTE a candidate; any miss leaves it exactly where the real
failure put it (review, `blocked_by_site` / `needs_javascript`). No extra network call is made by the verifier.

### Exact URL and redirect matching
- Identity = canonical URL: lower-case scheme and host, default port removed, fragment removed, one trailing slash on a non-root
  path removed. Everything else is significant: the whole query string, path case, `www.` versus bare host, `http` versus `https`.
  No tracking-parameter stripping and no alias table. URLs with credentials or a non-http(s) scheme never match.
- A returned page is held only if its URL is, canonically, one of the URLs dazl asked TinyFish to fetch in that attempt. A page
  TinyFish reports under a different URL (a redirect target, a canonical link) is not held, and a cited URL that merely redirects to
  held text does not match. Redirect chains are never followed.
- Never substituted: search snippets, news titles, model summaries, text from another candidate's URL, text from another scan
  attempt, a cache of earlier scans.

### Immutable attempt binding
- `HeldText.seal(attempt, requestedUrls, returnedPages)` is called once, inside the TinyFish collector, with
  `attempt = "<job id>:<attempts>"`. The sealed object is frozen; entries are frozen copies; later changes to the caller's arrays do
  not reach it. A SHA-256 of each text is taken at sealing.
- The verifier must present the same attempt string. A retry of the job (`attempts` + 1), a different job, or no binding yields no
  copy. CSV-company jobs, the news-only path and the fresh-window retry do not receive one.

### Preserved evidence and the real failure
- The original text is checked exactly as received (no cleanup, no markdown stripping beyond the verifier's own normalisation).
  Stored on the lead: `evidence_origin = 'tinyfish_copy'`, `own_fetch_failure` (the real own-fetch failure, `blocked_by_site` or
  `needs_javascript`), `evidence_copy_sha256` and `evidence_copy_id`. The saved quote is the model's original quote, verified
  verbatim, never rewritten.
- The ORIGINAL copied text is preserved in `lead_evidence_copies`: one immutable row per (tenant, job, attempt, canonical URL),
  linked from the lead by `evidence_copy_id`, holding the URL as cited, the exact page TITLE as received (the verifier accepts the company named in the title, so the title is
  evidence) with its SHA-256, the body's SHA-256, byte length, TinyFish fetch time and the full body as received. A trigger rejects every UPDATE; a DELETE is rejected until `expires_at`. Written in the same transaction as the lead.
  Access: `GET /api/leads/evidence?lead_id=` through the lead's job owner only (foreign, expired and missing are one 404), returns
  the title, text, both hashes, job, attempt, URL and an integrity check (both hashes recomputed; a changed row is reported as `mismatch`); the lead card links to it.
- Tenant deletion request: `purgeTenantEvidence` (operator tool `web/scripts/purge-tenant-evidence.mts`, not reachable from any HTTP
  route) is the only way to remove unexpired copies. It needs an operator name, a written reason (10+ chars) and the tenant id
  repeated as confirmation, and is a dry run unless `--execute`. In one transaction it opens THAT tenant's gate row (the delete
  trigger refuses every other tenant's rows even then), deletes that tenant's copies, clears `evidence_copy_id` and sets
  `evidence_purged_at` on that tenant's leads only, closes the gate and appends an `evidence_purge_audit` row (operator, reason,
  counts, bytes, time; append-only by trigger). A failure rolls everything back. Afterwards the evidence route answers 410
  `purged` (no text, no link), the lead card and the CSV say the copied text was deleted at the account owner's request and can no
  longer be shown or re-checked; the lead keeps its verification record and origin label. Normal edits and deletes stay blocked.
- Bounds: a copy over 256 KB is not used at all (so every used copy is stored whole); rows expire after 90 days and are purged
  on the next scan by the same tenant; a tenant holds at most 300 unexpired copies, and with no room the verifier is given no copies
  (candidates stay in review). At most the 16 fetched pages per scan can be used, and only pages that verified a lead are stored.
- Date rules are unchanged: an event date is what the quote/page text supports. A search hit date, a TinyFish fetch time or dazl's
  seal time never establishes an event date (the copy's `retrievedAt` is only the time it was held).

### Rejecting inadequate or wall text
- Minimum content: 400 characters of non-blank text, otherwise refused (`too_short`).
- Wall text: login, consent, bot-check and JavaScript-required notices in the first 1,500 characters refuse a short page (< 2,500
  characters); on a longer page a cookie banner alone is tolerated but a "log in to continue" notice at the very top is refused.
  The verbatim-quote rule still applies on top.
- Truncation: a copy whose end is a truncation marker ("…", "[truncated]", "read more", "see more", "continue reading", "show more")
  is refused (`truncated`), because absence checks (closed posting, rival named) cannot be run on text that may be cut. A quote that
  is missing from a long copy is simply `excerpt_not_on_page` and stays in review as before.

### Excluded
- Login-walled hosts (`facebook.com`, `instagram.com`, `nextdoor.com`, `linkedin.com`, `indeed.com`, `glassdoor.com` and
  subdomains) never use a copy, whatever TinyFish returned. `login_required` own-fetch failures are never answered by a copy.
- No sign-in, no cookies, no wall bypass, no new fetches, no paid retries, no extra spend.

### Honest labels
- Leads API: `evidence_origin`, `own_fetch_failure`, `evidence_copy_id` on every lead row. CSV column "Evidence Origin" states only
  what is recorded: copied evidence -> "Checked against a copy of the page fetched by TinyFish ... dazl did not read the page
  directly"; an unreadable review row -> "Not verified: dazl could not read this page (<failure>) ..."; a lead you confirmed out of a
  blocked/JS/login review -> "Confirmed by you, not verified by dazl: dazl could not read this page ..."; nothing recorded -> blank,
  and the header does not say blank means a direct read. Leads page: the copy sentence plus a link to the exact stored text.

## Tests (isolated; `web/test/held-text.test.ts`)
Positive: blocked and JavaScript-only own fetch with an exact-URL copy containing quote + company (verified, labelled, failure and
hash kept, original quote unchanged, exactly one TinyFish fetch and one own fetch, no other network call, CSV fields). Control: a page
dazl can read is not labelled. Negative (stay in review under the real failure, unlabelled): no copy, quote missing, company not
named, stale date, redirect/different returned URL, different query string, wall text, too short, truncated, walled social host.
Storage: byte-for-byte recovery from a fresh database connection after the scan, tenant isolation, immutability, retention purge, full-tenant and oversize copies unused. Real export and evidence routes: copied, unreadable-review, user-confirmed-blocked and plain rows. Unit: URL canonicalisation, attempt binding, requested-only holding, eligible failures, frozen entries, caller mutation after sealing.

## Remaining limits
- The title is stored as dazl's TinyFish client received it (that client cuts titles to 200 characters before verification), so the stored title is exactly the one the verifier used.
- Evidence copies are SQLite-only: the Postgres read path carries the lead columns, but the table and its triggers are not in the generated Postgres schema (the translator fails closed on a DELETE trigger) until that migration is done.
- Whether TinyFish text can differ from what a visitor sees is unmeasured; the verbatim-quote rule is the only defence beyond the
  wall/short/truncation guards. The wall-phrase list is English-only and heuristic.
- The truncation guard cannot detect silent cuts that end mid-sentence without a marker.
- A TinyFish copy is third-party text of a page dazl could not read itself; the label says so, but a downstream reader may still
  weigh it as less direct evidence than a page dazl read.
- Terms of third-party sites are why walled hosts stay excluded. Widening this to walled social evidence is separate scope.
- No live yield claim: green fixtures do not show that real scans now verify more leads.
