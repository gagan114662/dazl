# dazl status

Updated by the builder on every branch. Newest first.

## Score

- Baseline (Instinct, 2026-10-25, live Ohio scan on main 94e3c645): 2 search hits, 1 candidate, 0 verified,
  0 qualified reachable leads.
- Instinct, 2026-10-26, isolated discovery+verifier runs, main -> search/market-and-role-phrases (21521e7):
  Ohio hits 38 -> 78, candidates 2 -> 3, verified 0 -> 0; Lisbon hits 30 -> 53, candidates 2 -> 3, verified 0 -> 0.
  Bottleneck: 5 candidates blocked by their source sites, 1 quote unconfirmed.
- Scoreboard (scripts/scoreboard.mts): not yet run with a real key.

## In review

- `b/decision-maker-finder` (branched from decisions/email-and-scoreboard for the docs): contact crawl now tries /team and
  /leadership, accepts B2B titles (C-suite, Chief X Officer, VP/Head/Director of X) and keeps the 3 most senior people.
  Left: SEC officers and GitHub org members as extra sources; ICP-"who" ranking (lib/people/rank.ts) at selection time;
  JS-rendered team pages are not fetched.

- `search/market-and-role-phrases`: 21521e7 (country/language, quoted role phrases, budget), 13ccf6d (review
  fixes 1 and 3: non-English hiring requests, one place per query), ca98ade + 6d2dce0 (tenant daily limit 60,
  then 200 as a separate revertable commit with rationale).
- `decisions/email-and-scoreboard`: DECISIONS.md, PROCESS.md, STATUS.md, scoreboard runner.

## In progress (interactive Claude session, do not duplicate)

- `b/buyer-fit-gate`: Instinct finding 3, a job posting alone is not a qualified lead; require buyer-fit
  evidence and a contact route.
- Blocked-source verification: proposal sent to Instinct (verify against the text TinyFish already fetched for
  the same URL, same rules). Waiting for Instinct's yes/no. Do not start this without it.

## Next (in order, for the scheduled builder)

1. Email finder (US only, verified only, see DECISIONS.md): infer the company's address pattern from addresses it
   publishes, build candidates for the person from item 1, mailbox check, catch-all domains never verified.
2. New intent signal: people engaging with competitor GitHub repos (stargazers, issues) when the ICP names
   competitors; public GitHub API only.
3. Self-hosted SearXNG as a second free search backend (behind an env flag, off by default).
4. Production: Outreach page chunk-load failure (README "Current state").
