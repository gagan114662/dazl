# Product decisions

Decisions made by the owner (gagan). Agents read this before changing the behaviour it covers.
Newest first. A decision changes only when the owner says so.

## 2026-11-13: held leads get a people search inside the existing cap (Refs #1037)

Recorded on main by Hermes-PC after merging PR #1164 (0a048875), from the builder's text in PR comment 6871524111, per
docs/PROCESS.md as amended in 79c42b8b (branches must not edit docs/; Hermes writes STATUS.md and DECISIONS.md on main
after the merge).

Decided by the builder session under the lane's delegation from the owner (Hermes for Gagan, 2026-11-12: "make owner
decisions yourself, sensibly, and note them in the PR"); reversible by the owner. The post-scan people search (public
profile search results, `lib/people/people-search.ts`) also covers leads held for review, after every ready lead, inside
the same cap (5 per scan, 10 on a first play / free-trial scan; no new spend ceiling; the trial's 25% keep unchanged).
No scan spends a search on a lead graded out of the list (fit 0-1). Not searched, and shown no person line: a hold that
puts the company itself in doubt (a place that disagrees or is unconfirmed, someone else's customer, an owner's
self-description, the tenant's own form signal), a lead held when a free scan ran out of budget
(`trial_budget_reached`: its company may never have been checked), any reason not on the list
(`lib/people/searchable-holds.ts`), a rejected lead and a row with no company. A person shown on a held row carries the
same basis label as on a ready card and never makes the lead ready or sendable. Why: on real scans most candidates are
held (2026-11-13 matrix: 18 of 18), so "who do I contact" went unanswered on every row the user saw.

Added after Hermes-PC's review of PR #1164, decided by Hermes (option a): **a company name alone never ties a search
result to a lead, and the only tie is the lead's confirmed website.** A profile search result is stored only when its own
text names the lead's crawl-confirmed website (`lib/people/company-tie.ts`); otherwise it is refused and counted. A Y
Combinator-batch tie and a requested-city tie were built and dropped: free-text patterns kept leaking a same-name
business on new wordings, and a wrong name is worse than none. Results stored earlier by the name alone stay listed,
labelled "matched by the company name only - this may be a different business with the same name", and are never the
lead's person, the export's best person or a work-email target; a Leads row whose only people are such rows says why
none is shown. This lowers how many leads name a person, on purpose; the grounded lookup of #1102 is the path to naming
more.

## 2026-11-13: adaptive discovery round on by default (#381, PR #1132)

Decided by the builder session under the lane's delegation from the owner (Hermes for Gagan, 2026-11-12: "make owner
decisions yourself, sensibly, and note them in the PR"); reversible by the owner. The bounded adaptive round built in
#655 (one more TinyFish round when round one verified no lead: at most 3 searches, 6 pages and 1 extraction, different
queries on unseen pages, the same per-tenant daily caps, spend guards and verifier) runs by default for a scan a person
starts in Leads. It never runs for a free-trial scan, a run with paid_fallback=false, or a play's run (a watch's or
monitor's, scheduled or "Find leads now": a play runs under the caps it was confirmed with and gets no new estimate). The price estimate's maxima and the budget disclosure state it.
The operator turns it off with DAZL_ADAPTIVE_DISCOVERY_ENABLED=0. No new paid service: TinyFish is the existing operator
source under its existing daily cap; the extraction runs on the account's own key. Why: the audit (2026-11-12) measured
0.84 ready leads per scan; a scan that verified nothing gave up after one batch.

## 2026-11-12: Linking Google confirms the email in the same step (Refs #1095)

Decided by Hermes with authority delegated by the owner (gagan), posted on #1095
(https://github.com/gagan114662/dazl/issues/1095#issuecomment-6835411531), answering PR #1097's question. A password
account whose email is not yet confirmed may link a Google identity with exactly the same email, and the link
confirms the address: Google's ID token is checked with `email_verified` (`verifyIdToken`), which proves control of
that mailbox just as the confirmation link does and as dazl already trusts to create verified Google accounts
(`resolveUser`). Why: production sends no system mail yet (#1089), so a new password account could never confirm
and every first free search dead-ended. Limits, as built (`lib/auth-google.ts linkGoogle`, PR #1097): a fresh session
of that account, the same email, an identity no other account holds, all in one transaction with the identity
insert; `mismatch`, `taken` and a stale session never touch `email_verified_at`; the account's other sessions are
signed out; a link start that a browser marks cross-site or same-site (`Sec-Fetch-Site`) is refused, and sign-in and
sign-up accept only same-origin JSON (no cross-site login); a link that confirms the address also completes the
sign-up conversion queued for it (lifecycle), as a Google sign-in does. Only with the account's own fresh session. Residual risk: relies on Google's `email_verified` for non-Gmail addresses, as sign-up already does; not
reviewed by counsel.

## 2026-11-09: LinkedIn is top priority; the session engagers ship under three rules

Owner decision 2026-11-09 4:59pm via Quest: separate throwaway account, human pace, off by default (Refs #192,
PRs #192 and #949; "it needs to be as good as Gojiberry"). How the code holds each rule:
- Separate throwaway account: the session transport needs `LINKEDIN_SESSION_ACCOUNT` (a non-secret label naming
  the dedicated throwaway account, the operator's attestation) and EXACTLY ONE tenant in `LINKEDIN_SESSION_TENANTS`
  (the operator's dedicated tenant holding that session); two or more tenants turn it off, so the per-tenant caps
  are the account's caps. Never the owner's or any customer's own account.
- Human pace: at least 10 s (default 20 s) plus up to 50% jitter between session requests, at most 3 per run and
  3 per hour, and a daily cap (default 6, max 50), all atomic.
- Off by default: `LINKEDIN_SESSION_TRANSPORT=1` on top of every existing LinkedIn gate; nothing is set in production.
A checkpoint / captcha / restricted-account page or a logged-out answer stops the run, starts the 24 h cooldown AND
switches the tenant's `adv:linkedin` connector off until an operator re-enables it. Turning it on is Gagan's call
(via Instinct), after the controlled real-fixture capture.

## 2026-11-06: LinkedIn post engagers through a signed-in throwaway session

The owner authorised (Refs #192) reading the commenters and reactors of competitors' LinkedIn posts through a
signed-in session, Gojiberry-style, and explicitly accepted the risk that the account is restricted or banned.
Limits: ONE designated throwaway account only, never a person's own; read-only (no posting, reacting,
commenting, messaging or connecting); off by default behind its own flag and a tenant allowlist on top of
the existing LinkedIn gates; small hourly and daily caps with a human pace; a login wall, checkpoint/captcha or
rate limit stops the run visibly and is never recorded as zero results; every lead keeps a quote and the post
link and stays in the review lane. Details: docs/linkedin-people-source.md.

## 2026-11-02: consent/onboarding audit retention at tenant erasure

Resolves the owner decision #564 held open (`onboarding_audit` row contract for #417).

On `deleteTenant`, consent/onboarding audit rows do **not** erase with the tenant. They are retained,
content-free (no email, no person name — only the internal account/tenant ID, `conversion:<kind>`, and its
timestamp), for **2 years** after erasure, then purged. The internal ID is required: without it the record
cannot be tied to the account it is proof for and has no evidentiary value; it is not itself PII once
decoupled from the erased email/name. Reasoning: the row carries no PII, so retaining it costs ~nothing on
privacy, while erasing it removes the only evidence that consent was obtained right when a dispute is most
likely to surface (complaint, chargeback, regulator inquiry) — which can occur well after a tenant deletes
their account. 2 years is a practical window, not a specific statute; the exact period should be confirmed
against counsel as part of #535 (public legal policy / outbound-compliance disclosures) rather than
re-litigated per branch.

This settles the branch #564's `d39a7d72` provisional `ALWAYS_RETAINED` + append-only trigger structure
chose: that structure may now be treated as the settled default, not provisional.

## 2026-10-26: guessed email addresses (US only, verified only)

Contacts may include a pattern-guessed business address (for example first.last@company.com) only when all of these hold:

- the address was checked to accept mail (mailbox verification), and a domain that accepts every address
  (catch-all) is never counted as verified;
- it is shown labelled "guessed, verified", never as "published";
- the recipient is in the United States (CAN-SPAM: opt-out regime, unsubscribe already enforced).

Canada (CASL) and EU/UK recipients keep the earlier rule: only addresses the person or company published.
Unknown country counts as "not US". This replaces, for US recipients only, the 2026-10-21 contact-crawl rule
"no guessed or pattern-built addresses" (see `web/docs/CONTACT-CRAWL.md` and `docs/AUTOPILOT.md`).

## 2026-10-26: no paid data APIs

Lead quality has to come from open-source and free sources (public pages, job boards, SEC filings, GitHub,
community sites). Paid enrichment stays bring-your-own-key only.

## 2026-10-26: review before main

Every change goes on a branch. Instinct reviews the diff, runs the tests and live scans, and approves
before anything merges to main or is deployed.
