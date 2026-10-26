# Design: email finder (US only, verified only)

Status: needs a decision (owner + Instinct). Written by Claude (interactive, Opus), 2026-10-26.
Policy it must satisfy: `docs/DECISIONS.md` 2026-10-26 (guessed addresses only for US recipients, only when the
mailbox is verified, labelled "guessed, verified"; catch-all never verified; CA/EU/UK/unknown: published only).

## Problem

"Reachable" is one of the four conditions for a qualified lead, and today dazl only keeps role mailboxes
(info@, sales@) that a company publishes. The decision-maker finder (#185) can now name the right person, but
there is no address for that person. Gojiberry-class tools close this by guessing first.last@domain and checking
the mailbox.

## What it needs (three parts)

1. **Pattern inference (no network beyond pages we already fetch).** Learn the company's address format from
   personal addresses it publishes on its own site (team pages, press releases, blog bylines). Today
   `sitecrawl.ts` drops every non-role address before storing, so this needs the crawl to keep published
   personal addresses as *pattern evidence* (not as contacts, not shown, not emailed). Formats: first.last,
   flast, firstl, first, first_last, last. Require 2+ published examples agreeing, or 1 example plus the domain's
   MX belonging to a mainstream provider. No inference from one-off examples on other domains.
2. **Candidate address** for the named person from #185: apply the pattern. Only when the person, the pattern
   and the company domain all come from the company's own site.
3. **Mailbox verification.** This is the hard part, see below.

## Mailbox verification: the real constraint

Verifying means an SMTP conversation with the company's mail server (MX lookup, `RCPT TO`, no message sent).
- **Port 25 outbound is blocked on EC2 by default.** AWS lifts it only on request (account form, reverse DNS, a
  stated use case), and they may refuse for lead-gen. Without it, verification cannot run from the dazl server.
- **Catch-all domains** accept every address; they must be detected (probe a random impossible address first)
  and then the result is "unverifiable", never "verified".
- **Microsoft 365 and Google Workspace** increasingly answer `RCPT TO` ambiguously or rate-limit and greylist;
  a share of US business domains will always be "unknown".
- **Sender reputation:** probing from the same IP that sends outreach can get that IP listed. Verification must
  run from a separate IP, never the Gmail-sending path.

## Options

| Option | Cost | Quality | Risk |
|---|---|---|---|
| A. Ask AWS to lift port 25 on the dazl instance, probe from there | free | good | AWS may refuse; probing from the app server's IP risks its reputation |
| B. Small separate VPS with port 25 open (e.g. a $5/month provider that allows it) running the open-source Reacher (check-if-email-exists, AGPL) as an internal HTTP service, called like the existing optional workers | ~$5/month | good | one more service to run; AGPL is fine for an internal network service but must stay a separate process |
| C. No SMTP check; show pattern-guessed addresses as "guessed, unverified" | free | poor | violates DECISIONS.md (verified only). Not allowed without a new owner decision. |
| D. Only published personal addresses (no guessing) | free | low coverage | none; this is what dazl effectively does today for roles only |

## Recommendation

**B**, in this order: (1) pattern inference + candidate generation behind a flag (buildable now, no new
infrastructure, produces no visible contact until verification exists); (2) the verification worker as an
optional service exactly like `worker/` and `session-worker/`, off unless `EMAIL_VERIFY_URL` is set;
(3) only then show "guessed, verified" addresses, US recipients only.

## Open questions for the owner and Instinct

1. Approve a ~$5/month VPS for verification (option B), or ask AWS for port 25 (option A)?
2. How is "US recipient" decided: company HQ country from its own site, the ICP's country, or both must agree?
   (Unknown counts as not US, per DECISIONS.md.)
3. Retention: store failed and catch-all probe results (to avoid re-probing) or keep nothing?
4. Daily cap on probes per tenant and globally (suggest 100/tenant/day, 1,000 global) to protect the IP.

## For the scheduled builder

Part 1 (pattern evidence kept by the crawl, inference, candidate generation, all behind
`EMAIL_GUESS_ENABLED=0` by default and never shown or sent) is buildable now. Parts 2-3 wait for answers above.
