# Email finder (guessed business addresses)

Rule: `docs/DECISIONS.md` 2026-10-26 "guessed email addresses (US only, verified only)". Code:
`web/lib/people/email-pattern.ts`. Issue #899. Off unless `EMAIL_GUESS_ENABLED=1`.

## Parts

1. **Pattern inference (built).** From personal addresses a company publishes on its own confirmed site, learn
   its format (`first.last`, `flast`, ...). A format needs 2+ supporting people and must be strictly ahead of the
   runner-up. Candidates for the people listed on that site go to `email_candidates` with `status = 'unverified'`.
2. **US company-site storage filter (built, not recipient-country proof).** Candidates are recorded only when the confirmed homepage states a US street address
   (`City, ST 12345` with a real state code), the scan geography names no other country, and the homepage shows
   no Canadian postal address. Unknown country = not US: nothing is written. The address that qualified the lead
   is kept on each row as `country_basis`. This establishes company-site evidence only: a named employee may
   work elsewhere. No person-level recipient-country verification or activation approval follows from it.
3. **Mailbox verification (built; ZeroBounce free tier wired, #899).** `verifyCandidates` runs a pluggable `MailboxVerifier`. The
   scan runner calls it (`verifyJobCandidates`) as the LAST post-finish step, on whatever time is left, traced as `email_verify`. Production verifier: ZeroBounce (`lib/people/zerobounce.ts`), used only when
   **all three** are set: `EMAIL_GUESS_ENABLED=1`, `ZEROBOUNCE_API_KEY` (a free account; never upgraded) and
   `EMAIL_VERIFY_DAILY_CAP` > 0. `EMAIL_VERIFY_MONTHLY_CAP` (optional) can only lower the monthly allowance below the free 100.
   A bad key, no credits or a rate limit stops every further check of that crawl.
   - fails closed: only an explicit `deliverable` answer sets `verification = 'verified'`; `catch_all`,
     `undeliverable`, `unknown`, `refused`, a thrown error, or a malformed answer are stored as their own
     non-verified state and surfaced, never zero-filled;
   - spend cap in code: `EMAIL_VERIFY_DAILY_CAP` checks per tenant per UTC day (default 0 = no check). Each slot
     is reserved (`verification = 'pending'`, `checked_at`, `verifier`) inside a transaction before the
     provider call, so a crash or hang still counts and a pending row is never verified;
   - monthly cap: at most the free allowance (100) per verifier per UTC month across every tenant of the database, counted in
     the operator ledger `email_verify_usage` (no tenant data, kept when a tenant is deleted) in the same transaction;
   - only candidates with US provenance (`country_basis`) are checked.
   - `candidateLabel` gives the only labels a guessed address may carry ("guessed", "guessed, verified", ...);
     "verified" also needs `checked_at`, `verifier` and `country_basis`. Never "published".

4. **Free-first tiers (built).** Before any paid check, use what the confirmed site already prints:
   - **published**: a person named on the site whose own address (any known format of their name) is printed on one of
     the site's crawled pages. Stored as printed but lower-cased (its own domain kept, never rebuilt onto another); the domain must be the confirmed site or a subdomain of it, compared case-insensitively, `tier = 'published'`, with
     `source_url` = that page. Labelled "published" only with that page; otherwise "guessed". Never mailbox-checked.
    Attribution needs the page to identify the person unambiguously: when two named people could both own a printed
    address (e.g. `asmith@` for Anna and Alex Smith), it is attributed to neither, supports no pattern, and no guess
    reuses it. Two people whose guesses collide under the pattern get no guess. A printed address is not proof of
    who owns it, nor that its mailbox exists.
   - **pattern confidence**: `rankPattern` grades the learned format: `high` (2+ supporters, no rival format; score
     90/95), `medium` (2+ supporters but a rival format also seen; score 70 x share), `low` (one supporting address;
     score 35); a tie is no pattern. `email_patterns` stores `confidence`, `score`, `runner_up` and `evidence` (the
     supporting addresses with the page each was printed on).
   - **guessed** rows carry the pattern's `confidence`. Only `tier = 'guessed'` with `confidence = 'high'` is eligible for
     the optional, capped (default 0) mailbox check. Medium and low stay "guessed". Same US-only gate for both tiers.
   No extra fetches: addresses come from pages the crawl already reads (`crawlSite` hands each page's HTML and URL).

5. **Find work email on a lead (#1036, built).** `web/lib/people/work-email.ts`, route `POST /api/leads/[lead]/work-email`,
   button in the lead's Details under "Right people". One click, one named buyer, the workspace's OWN keys:
   - who: a stored person on the lead whose title matches the play's buyer roles (or, with none entered, a decision-maker
     title), not former / retired / assistant-to / historical, with a first and last name; the lead must sit on a settled
     website (`identityOf` fact or user-confirmed). The server re-derives the person from stored rows.
   - order: (1) the person's **published** address from this table (`publishedCandidateFor`, read-only, tier 'published'
     with its page only); (2) Apollo `people/match`; (3) People Data Labs person enrich when Apollo has no usable address
     and the PDL paid fallback is allowed (#382 opt-in). A kept address stops the waterfall.
   - checked = Apollo's own `email_status: verified` (stored with provider and date) or published (with the page). PDL
     and Apollo's other statuses are stored as "found, not checked" and say so; Apollo's guessed / extrapolated addresses
     are never kept. The address must be the same person, not a past role, at the lead's website domain, not a shared
     inbox, and the provider must place the person in the US (else nothing is kept; unknown = not US). A namesake at
     the same company is refused: the provider's LinkedIn profile must equal the stored one when both are known;
     otherwise the provider must name the company and list the same role as the stored title. The same name+title
     stored with two different profiles is not offered at all.
   - unfinished = retryable: if a provider that was allowed gave no answer (unreadable key, credit limit, timeout or
     error), the lookup ends as 'Lookup failed, try again', never as a final 'not found'. Whether PDL may run is
     decided from the saved keys and the opt-in before any key is decrypted.
   - the page merges what the server returns by time (an older read never erases a newer result) and re-reads a
     lookup that is running in another tab until it finishes or becomes retryable. Deleting a lead (commenter batch
     delete, first-party erase/retention) deletes its lookups too.
   - spend: 1 credit reserved per paid call in the workspace credit pool (Settings > Enrichment counters and limits)
     before the call; a durable 'pending' claim makes double clicks and replays pay once; finished lookups replay free.
   - storage: `work_email_lookups` (PG 0061); its CHECKs make 'verified' impossible without Apollo and a check time and
     'published' impossible without its page (a NULL provider never passes). It is NOT a contact: drafting still uses published addresses only.

## Not done on purpose

- **No provider is wired.** `verifierFromEnv` returns null. Picking a verification provider (and paying for it)
  is the owner's decision; a provider adapter plus a sandbox test is a follow-up after that go.
- **No outreach consumer reads candidates; the lead page reads only the published tier.** No outreach path reads
  `email_candidates`, and only `publishedCandidateFor` (in `email-pattern.ts`, still the only module touching the table)
  hands Find work email a published row with its page; guessed rows of any state are never shown (enforced by
  `test/email-pattern.test.ts`, `test/legal-policy.test.ts` and `test/work-email-1036.test.ts`). Showing "guessed, verified"
  addresses to a seller is a separate, gated change. The generic tenant lifecycle export/deletion covers these
  directly tenant-scoped tables; that data-access path is not a contact consumer (see `docs/TENANT-LIFECYCLE.md`).
- No live mailbox probes (SMTP RCPT) from dazl's own servers.

## Supported scope and remaining #899 dependencies

The supported scope is continued, isolated candidate storage and synthetic verifier-interface testing, not a
production email-finding service. Parts 2-3 above describe code that exists, not permission to activate it.
The restored design and free-first additions are tracked by #977 and #980. #899 stays open until its original
scope choice and dependency accounting are reviewed; this ledger does not close it or approve deployment.
Historical design: [#189](https://github.com/gagan114662/dazl/pull/189), part 1:
[#190](https://github.com/gagan114662/dazl/pull/190). No retirement or data deletion is proposed.

Before any provider, consumer or operational activation, the following remain separate reviewed work:

| Dependency | Current evidence | Required decision and proof before activation |
|---|---|---|
| Recipient country | Confirmed company homepage US street address, scan-country exclusions, stored `country_basis` | Owner-approved person-level US-recipient rule and negative/unknown/remote-worker cases. Company address alone is insufficient. |
| Provider and infrastructure | `verifierFromEnv` always returns null, including with `EMAIL_VERIFY_URL`; injected verifiers are test fixtures | Owner chooses provider/infrastructure and permitted data disclosure. Review sandbox adapter and failure handling. No dazl-host SMTP probes or new infrastructure are authorized. |
| Rate and money | Per-tenant UTC-day reservation, default cap 0; pending checks count | Explicit cost authority, exact provider pricing, aggregate/rate limits and concurrency/crash tests for the selected adapter. A positive environment cap is not spending permission. |
| Retention | Generic tenant export/deletion includes directly tenant-scoped candidate tables; no email-finder-specific retention window chosen | Owner chooses retention for addresses, pattern evidence and probe results, including provider-side storage/deletion, then test expiry/deletion. Existing lifecycle support is not a retention decision. |
| Consent and contact use | No candidate-to-contact, enrichment, draft or send consumer | Review applicable consent/opt-out and contact-purpose rules plus negative cases before any exposure. Mailbox acceptance is not consent, publication or proof of person identity. Consumer wiring needs its own reviewed boundary. |
| Deployment and activation | Code defaults remain OFF/unwired; local synthetic tests only | Separate operational approval and final-state verification. Merges and this document make no claim about deployed flags, live probes or successful email delivery. |

`web/test/email-candidate-outreach-boundary.test.ts` exercises real SQLite contact/draft gates with flag-on
candidate storage: every verification state, published-tier stored rows, foreign tenant refusal, zero draft writes,
and an independent published-contact positive control. It also proves flag-off verification leaves existing
storage unchanged and never calls an injected verifier. `email-pattern.test.ts` retains disabled fresh-store
no-write/no-table creation and static consumer guards. These are offline fixtures, not provider integration,
Postgres runtime outreach, a live-send test, person-level country proof or operational consent acceptance.
