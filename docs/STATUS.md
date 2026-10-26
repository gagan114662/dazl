# dazl status

Updated by the builder on every branch. Newest first.

## Score

- Baseline (Instinct, 2026-10-25, live Ohio scan on main 94e3c645): 2 search hits, 1 candidate, 0 verified,
  0 qualified reachable leads.
- Scoreboard numbers: not yet run (needs the test key; reviewer runs it).

## In review

- `search/market-and-role-phrases` (21521e7): buyer country/language sent to TinyFish, quoted role phrases,
  one-signal queries, budget 8 searches / 16 fetches. Instinct findings 1 and 2.
- `decisions/email-and-scoreboard`: DECISIONS.md, PROCESS.md, STATUS.md, scoreboard runner.

## Next (in order)

1. Fix review findings on the branches above.
2. Finding 3: a job posting alone is not a qualified lead; require buyer-fit evidence and a contact route.
3. Decision-maker finder: name and title of the right person from the company's own pages, SEC filings, GitHub.
4. Email finder (US only, verified only, see DECISIONS.md): company pattern from published addresses, mailbox check,
   catch-all never verified.
5. New intent signal: people engaging with competitor GitHub repos (stars, issues), funding filings beyond Form D.
6. Self-hosted SearXNG as a second free search backend.
7. Production: Outreach page chunk-load failure.
