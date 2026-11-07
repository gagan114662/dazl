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

## Not done on purpose

- **No provider is wired.** `verifierFromEnv` returns null. Picking a verification provider (and paying for it)
  is the owner's decision; a provider adapter plus a sandbox test is a follow-up after that go.
- **Nothing reads candidates outside this module.** No page, export or outreach path reads `email_candidates`
  (enforced by `test/email-pattern.test.ts` and `test/legal-policy.test.ts`). Showing "guessed, verified"
  addresses to a seller is a separate, gated change.
- No live mailbox probes (SMTP RCPT) from dazl's own servers.
