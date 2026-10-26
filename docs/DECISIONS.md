# Product decisions

Decisions made by the owner (gagan). Agents read this before changing the behaviour it covers.
Newest first. A decision changes only when the owner says so.

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
