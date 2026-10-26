# dazl status

Updated by the builder on every branch. Newest first.

## Score

- Baseline (Instinct, 2026-10-25, live Ohio scan on main 94e3c645): 2 search hits, 1 candidate, 0 verified,
  0 qualified reachable leads.
- Instinct, 2026-10-26, isolated discovery+verifier runs, main -> search/market-and-role-phrases (21521e7):
  Ohio hits 38 -> 78, candidates 2 -> 3, verified 0 -> 0; Lisbon hits 30 -> 53, candidates 2 -> 3, verified 0 -> 0.
  Bottleneck: 5 candidates blocked by their source sites, 1 quote unconfirmed.
- Scoreboard (scripts/scoreboard.mts): not yet run with a real key.

## Merged

- #183 search: country/language, quoted role phrases, non-English hiring, one place per query, budget 8/16,
  tenant daily 200 (Instinct reviewed and merged 2026-10-26). Not yet deployed.
- #184 process docs + scoreboard (Instinct reviewed and merged 2026-10-26).

## In review (owner goal: better than Gojiberry/Pancake at finding leads for any business, any geography)

- #186 b/buyer-fit-gate: a job posting alone is not a qualified lead (home-page fit evidence, multilingual hiring).
- #187 docs/process-instinct-merges: PROCESS (Instinct merges, design items), this STATUS.
- #188 b/verify-provenance: diagnostic, did TinyFish have text for pages the verifier could not read.
- #189 b/design-email-finder: DESIGN note, needs owner answers (verification server, US rule details).
- #190 b/email-pattern: email format inference, unverified candidates in own tables, off by default.
- #191 b/dm-icp-rank (on #190): buyer roles first per site; buyer titles derived from the scan ICP (no fixed list).
- #192 b/linkedin-people: LinkedIn engagers + people search via the tenant session (owner decision), not live-tested.
- #193 b/people-search (on #191): right people from public profile search results; Right people UI shows them.
- #194 b/extraction-yield: markdown-free evidence, one verbatim passage per company.
- #195 b/news-search: free Bing News RSS beside TinyFish and before paid research.
- integration/all-open: all of the above merged, for one scoreboard run (not for merging).

## In progress (interactive Claude session, do not duplicate)

- Blocked-source verification: waits for #188 data from a live run.

## Next (in order, for the scheduled builder)

1. Decision-maker finder, part 2 (after #185): officers from SEC filings, GitHub org members, rank by the
   ICP's "who" roles at crawl time (lib/people/rank.ts exists).
2. Email finder, PART 1 ONLY (see docs/design/email-finder.md, PR "DESIGN: email finder"): keep published personal
   addresses as pattern evidence (never shown or sent), infer the pattern, generate candidates for named people, all
   behind EMAIL_GUESS_ENABLED=0. Parts 2-3 (mailbox verification, display) are "needs design" until the owner answers
   the open questions in that note.
3. New intent signal: people engaging with competitor GitHub repos (stargazers, issues) when the ICP names
   competitors; public GitHub API only.
4. Self-hosted SearXNG as a second free search backend (behind an env flag, off by default).
5. Production: Outreach page chunk-load failure (README "Current state").
