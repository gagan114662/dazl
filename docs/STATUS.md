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
  tenant daily 200. #184 process docs + scoreboard. #185 decision-maker finder. #186 buyer-fit gate.
  #187 process (Instinct merges). #190 email format inference (off by default). #200 guessed domains must match the
  lead location. #201 recency window kept and enforced. #202 copy matches behaviour. #203 country codes (UK -> GB).
  #205 lead quarantine. #207 opportunity card. #208 hard recency window gate at every outreach path, malformed saved window_days recovers
  the query window or holds. All reviewed and merged by Instinct 2026-10-26. Not yet deployed.

## In review (owner goal: better than Gojiberry/Pancake at finding leads for any business, any geography)

Merge order matters: #191 -> #193 -> #196; #207 and #206 need the merged #208 (done).

- #188 b/verify-provenance: diagnostic, did TinyFish have text for pages the verifier could not read.
- #189 b/design-email-finder: DESIGN note, needs owner answers (verification server, US rule details).
- #191 b/dm-icp-rank: buyer roles first per site; buyer titles derived from the scan ICP (no fixed list).
- #192 b/linkedin-people: LinkedIn engagers + people search via the tenant session (owner decision), not live-tested.
- #193 b/people-search (on #191): right people from public profile search results. Review fixes in: past roles,
  one role + one attached employer, tenant ownership, quarantine, 30s deadline. Owner running combined checks.
- #194 b/extraction-yield: markdown-free evidence, one verbatim passage per company.
- #195 b/news-search: free GDELT news search beside TinyFish and as first fallback.
- #196 b/export-people: CSV best person + why this lead; depends on #193.
- b/window-counts (this PR): with an explicit window only a valid in-window date counts as a scored lead; moved leads
  are stored under needs_review with reasons outside_window / outside_window_undated / event_date_bad_date /
  event_date_future_date. Behaviour change: verified counts drop by those leads; verified + needs_review is unchanged.
- #206 b/window-widen: say when the time window excluded results; offer an explicit widen.
- Stale, merge or close (no activity since 2026-10-22/23): #121, #132, #133, #147, #153, #164, #175.
- integration/all-open: all of the above merged, for one scoreboard run (not for merging).

## In progress (interactive Claude session, do not duplicate)

- Blocked-source verification: waits for #188 data from a live run.

## Known gaps (logged in reviews, not yet built)

1. (Fixed in #window-counts, in review) Window counts: with an explicit window, stale/undated/invalid/future leads now
   go to the review lane with their own reason, so verified counts never include a lead the outreach gate holds.
2. People search: ambiguous or multi-employer profile lines are dropped; there is no separate "research candidate"
   store. Needs a small table and UI, and a design decision on whether they may be shown at all.
3. Identity/channel consistency has unit tests per module but no single test that the card, createDraft and the CSV
   export agree for the same lead (see the consistency test branch b/e2e-consistency, test only).
4. No live end-to-end run since the gates landed. Instinct runs it; the builder does not run live scans.
5. Scoreboard never run with a real key, and no competitor comparison number exists (PROPOSED target below).

## Proposed target (needs owner approval, then move to DECISIONS.md)

"Better than Gojiberry/Pancake" is only testable on a fixed set. Proposal: run `scoreboard/searches.json` plus the same
searches typed into the competitors by the owner, count qualified leads (verified, dated in window, ICP fit >= 4/5,
reachable) per search, and ship only changes that raise dazl's count or hold it. Target to set by owner: N qualified
per search. dazl's own baseline today: 0 qualified (Instinct, 2026-10-25), so the first goal is the first verified,
reachable lead per search, not parity.

## Score

- Baseline (Instinct, 2026-10-25, live Ohio scan on main 94e3c645): 2 search hits, 1 candidate, 0 verified,
  0 qualified reachable leads.
- Instinct, 2026-10-26, isolated discovery+verifier runs, main -> search/market-and-role-phrases (21521e7):
  Ohio hits 38 -> 78, candidates 2 -> 3, verified 0 -> 0; Lisbon hits 30 -> 53, candidates 2 -> 3, verified 0 -> 0.
  Bottleneck: 5 candidates blocked by their source sites, 1 quote unconfirmed.
- Scoreboard (scripts/scoreboard.mts): not yet run with a real key.

## Next (in order, for the scheduled builder; nothing business- or place-specific)

Rule first: fix review findings on open PRs before anything here. Do not start these while 3+ PRs wait on Instinct.

1. Extend the card-vs-send-gate consistency test (#210) to the CSV export once #193 and #196 merge: for the same lead,
   the exported "best person" and contact columns must never be a person/address the send gate would refuse. Fixtures only.
2. Blocked-source verification, once #188 data exists (the 5 of 6 candidates blocked by their source sites).
3. Decision-maker sources beyond the company site: officers named in SEC Form D filings (US), GitHub org members for
   software companies. Stored as person enrichments with the source URL; ranked by the scan ICP roles (rank.ts).
4. New intent signal: people opening issues on or starring competitor GitHub repos when the tenant lists
   competitors; public GitHub API only.
5. Self-hosted SearXNG as a third free search backend (env flag, off by default), same shape as lib/search/news.ts.
6. Production: Outreach page chunk-load failure (README "Current state").
Needs owner/design first, do not build: known gap 2, the proposed target, email finder (#189).
