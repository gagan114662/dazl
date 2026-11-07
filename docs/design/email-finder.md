# Email finder (guessed business addresses)

Rule: `docs/DECISIONS.md` 2026-10-26 "guessed email addresses (US only, verified only)". Code:
`web/lib/people/email-pattern.ts`. Issue #899. Off unless `EMAIL_GUESS_ENABLED=1`.

## Parts

1. **Pattern inference (built).** From personal addresses a company publishes on its own confirmed site, learn
   its format (`first.last`, `flast`, ...). A format needs 2+ supporting people and must be strictly ahead of the
   runner-up. Candidates for the people listed on that site go to `email_candidates` with `status = 'unverified'`.
2. **US only (built).** Candidates are recorded only when the confirmed homepage states a US street address
   (`City, ST 12345` with a real state code), the scan geography names no other country, and the homepage shows
   no Canadian postal address. Unknown country = not US: nothing is written. The address that qualified the lead
   is kept on each row as `country_basis`.
3. **Mailbox verification (built, unwired).** `verifyCandidates` runs a pluggable `MailboxVerifier`:
   - fails closed: only an explicit `deliverable` answer sets `verification = 'verified'`; `catch_all`,
     `undeliverable`, `unknown`, `refused`, a thrown error, or a malformed answer are stored as their own
     non-verified state and surfaced, never zero-filled;
   - spend cap in code: `EMAIL_VERIFY_DAILY_CAP` checks per tenant per UTC day (default 0 = no check). Each slot
     is reserved (`verification = 'pending'`, `checked_at`, `verifier`) inside a transaction before the
     provider call, so a crash or hang still counts and a pending row is never verified;
   - only candidates with US provenance (`country_basis`) are checked.
   - `candidateLabel` gives the only labels a guessed address may carry ("guessed", "guessed, verified", ...);
     "verified" also needs `checked_at`, `verifier` and `country_basis`. Never "published".

4. **Free-first tiers (built).** Before any paid check, use what the confirmed site already prints:
   - **published**: a person named on the site whose own address (any known format of their name) is printed on one of
     the site's crawled pages. Stored exactly as printed (domain kept, never rebuilt), `tier = 'published'`, with
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

## Not done on purpose

- **No provider is wired.** `verifierFromEnv` returns null. Picking a verification provider (and paying for it)
  is the owner's decision; a provider adapter plus a sandbox test is a follow-up after that go.
- **Nothing reads candidates outside this module.** No page, export or outreach path reads `email_candidates`
  (enforced by `test/email-pattern.test.ts` and `test/legal-policy.test.ts`). Showing "guessed, verified"
  addresses to a seller is a separate, gated change.
- No live mailbox probes (SMTP RCPT) from dazl's own servers.
