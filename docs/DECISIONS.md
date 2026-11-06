# Product decisions

Decisions made by the owner (gagan). Agents read this before changing the behaviour it covers.
Newest first. A decision changes only when the owner says so.

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
