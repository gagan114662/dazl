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

## In review

- #185 merged: decision-maker finder (scheduled builder): B2B titles, /team and /leadership pages; still keeps 3
  people per site, now most senior first (the PR said "up to 5": inaccurate, Instinct caught it).
- #186 `b/buyer-fit-gate` (Instinct finding 3): hiring leads keep fit >= 4 only with home-page fit evidence.
- #187 `docs/process-instinct-merges`: PROCESS says Instinct merges; design items are flagged, not built.

## In progress (interactive Claude session, do not duplicate)

- Blocked-source verification (design item): waiting for Instinct's data on whether TinyFish fetched the cited
  pages that the verifier found blocked. Do not start this without it.

## Next (in order, for the scheduled builder)

1. Decision-maker finder, part 2 (after #185): officers from SEC filings, GitHub org members, rank by the
   ICP's "who" roles at crawl time (lib/people/rank.ts exists).
2. Email finder (US only, verified only, see DECISIONS.md): infer the company's address pattern from addresses it
   publishes, build candidates for the person from item 1, mailbox check, catch-all domains never verified.
3. New intent signal: people engaging with competitor GitHub repos (stargazers, issues) when the ICP names
   competitors; public GitHub API only.
4. Self-hosted SearXNG as a second free search backend (behind an env flag, off by default).
5. Production: Outreach page chunk-load failure (README "Current state").
