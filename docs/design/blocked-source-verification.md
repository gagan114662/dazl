# DESIGN: verifying against the text we already hold when our own fetch is blocked

Status: proposal for owner/Instinct decision. Not built. Per `docs/PROCESS.md` a change to the evidence verifier is a design item.

## Problem

The 2026-10-26 live NYC acceptance run (#204) produced one candidate, a Facebook group post, and the verifier stored it in review
as `blocked_by_site`: our own fetch of the cited page was refused, so the quote could not be checked. The earlier isolated runs
(STATUS "Score") had 5 of 6 candidates blocked by their source sites. A blocked candidate can never become verified, so every
scan that finds its evidence on a page our fetcher cannot read loses that lead.

## What already exists

- #188 (`verify_provenance`, merged) records, per scan, whether TinyFish had page text for URLs the verifier then could not read.
  It has not been read from a live run yet, so we do not know how often the text we hold would have been enough.
- TinyFish fetch (up to 16 pages per scan) already returns page text that feeds the extraction prompt (`toEvidence`). That text is
  discarded after extraction; the verifier fetches the page again with its own fetcher.

## Proposal (smallest version)

When the verifier's own fetch of a candidate's `source_url` fails with `blocked_by_site`, `needs_javascript` or `login_required`,
and TinyFish returned text for exactly that URL in this scan, run the SAME checks on that text:

1. the quote must appear verbatim in the text (existing normalised match, no loosening);
2. the company must be named with the quote (existing rule);
3. the date rules are unchanged: an event date is whatever the quote/page text states; a search-index timestamp is never a date.

Unchanged: the checks, thresholds, the window gate, the identity gates and every outreach gate. Only the origin of the page text
changes, and it is labelled: the lead shows "checked against a copy of the page fetched by TinyFish, our own fetch was blocked",
and `source_check.fetch_status` keeps the real failure. A lead verified this way is never described as "read on the page by dazl".

## Not proposed

- No login, no cookies, no signed-in collection, no paid retries, no new fetches. Only text already fetched for extraction.
- No use for pages TinyFish could not read either. No change to the review lane for those.

## Risks and open questions

1. Is a TinyFish copy acceptable evidence? It is third-party text of a page we cannot read ourselves. It might differ from what a
   visitor sees (login interstitial text, truncated markdown). Mitigation: the same verbatim-quote rule, plus a minimum length and
   a refusal when the text looks like a login/consent wall.
2. Terms: fetching walled social pages through a provider may breach those sites' terms even though the provider performs it.
   The owner should decide whether walled social hosts are excluded from this path (the proposal can exclude them by host).
3. Honesty in the UI: the label above is mandatory; the CSV needs the same column.
4. We have no live data on how often this would change the outcome. Decision needed before building: read the #188 diagnostic from
   one authorized ordinary scan per customer request, then decide.

## Test plan (when approved)

Isolated stubs only: blocked own fetch + TinyFish text with the quote (verified, labelled); blocked + no TinyFish text (review, as
now); blocked + text without the quote or without the company (review); wall-text pages (review); excluded hosts (review);
date rules unchanged for each; no extra network calls; labels in the leads API and CSV.
