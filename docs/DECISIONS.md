# Product decisions

Decisions made by the owner (gagan). Agents read this before changing the behaviour it covers.
Newest first. A decision changes only when the owner says so.

## 2026-10-26: LinkedIn is allowed for lead discovery

Owner decision: "LinkedIn should be allowed", build it like Gojiberry. dazl may read LinkedIn to find people:
public profile search results (no login), and through each tenant's own LinkedIn session in the session worker:
people search, and the people who comment on or react to posts about the tenant's competitors.
Conditions: the tenant's own session only (saved by them, after the LinkedIn consent notice, which states that
LinkedIn's terms forbid automation and the account can be restricted); the per-tenant hourly LinkedIn cap stays;
results are labelled as LinkedIn-sourced and stay in the review lane because dazl cannot re-read a LinkedIn page.
Not decided yet (ask the owner first): automated LinkedIn actions (connection requests, messages, posting).

Implementation approach (#192 rework, reviewer's brief): the code does NOT log in to LinkedIn, use or store a member session, or call unofficial endpoints. The person-level reader
(`web/lib/signals/linkedin-people.ts`) consumes an injected, authorised transport and is OFF by default (`ADVANCED_LINKEDIN_PEOPLE=1`, the tenant's LinkedIn consent, and a transport
must all be present; with no transport it reports "unavailable", not "no people"). Official sources come first: LinkedIn's official APIs and the member's own data export are the only
acceptable feeds for it; whether an official API exposes people search or post-engagement lists for this use must be checked against LinkedIn's current developer terms before any
transport is written, and is NOT verified here. The earlier session-worker people/engagers fetchers were removed. Per-request and per-hour budgets, per-tenant cooldown after a
throttle/challenge/unauthorised answer, tenant-separated budgets, review-lane-only leads (login_required, never emailed automatically).

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
