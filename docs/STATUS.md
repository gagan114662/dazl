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

## In review (code fixes only)

- b/first5 (#324) review fix (Instinct 2026-10-28 23:08): first5 no longer runs the post-finish TinyFish people search (runner gate, trace note `skipped`); the first5 budget disclosure reports search_and_fetch as `off` (and says model calls are not free). Pinned by a real-runner test with tinyfish tables initialised plus a non-first5 control that does search.

- b/cost-bounds (#221) review fixes (Instinct 2026-10-27): BYOK enrichment disclosure now says it is off only for max_usd or credit_enrichment=false (what the runner does), pinned by a real-runner test per budget form; profile-generation bound now built from the largest JSON-escaped prompt (control chars, 6 bytes each), checked against ASCII/quote/backslash/BMP/astral/control/newline inputs, and states that unlisted models are not covered. No behaviour change.

- b/window-counts (#211): with an explicit window only a valid in-window date is counted in `verified`; stale, undated,
  invalid and future dates are stored under needs_review with a reason each. verified + needs_review is unchanged.
  Existing scans are not backfilled. Fixture tests only; no live run.

- b/source-select (source quality, from the 2026-10-26 live NYC/London failures; fixtures only): (1) the hiring-board
  search used instruction fragments as roles ("exclude chains", "dated source", "past", "need founder contacts",
  "raised seed funding"), found by running reconstructed versions of the two requests (verbatim saved text and results
  are not available to the builder); now cut from role extraction. (2) The search window was a fixed 365 days; now the
  user's window when set. (3) Hiring-board queries took up to 6 of 8 searches; now at most half. (4) Login-walled hosts
  (Facebook, Instagram, Nextdoor, LinkedIn) are fetched and listed after readable hosts and their site: targets are
  removed unless the request names them. (5) The query prompt states the user's window and prefers dated, readable
  sources. Not verified live: whether this raises yield.

- b/scan-cost-control (#216; fixtures only, no live run): a PARTIAL, API-ONLY per-run budget on POST /api/scan, NOT a
  whole-scan dollar ceiling. Optional `budget` ({max_usd, paid_fallback:false, credit_enrichment:false, judge:false}),
  validated before anything is queued (invalid -> 400 `invalid_budget`, no job), saved with the job in the same insert,
  and answered with the paid surfaces allowed/refused/off/not covered. max_usd is a reservation limit on the guarded model
  requests only, computed from what dazl sends (not a bill, not a vendor-enforced ceiling); web-search research is refused
  under it (not the same search behaviour as an ordinary scan; a refusal ends as budget_stopped, not "nothing found").
  The job's reservation must be SAVED by the current attempt of a running job before a provider call is allowed (storage
  failure or lost ownership refuse the call; Instinct's fail-open finding). EXCLUDED from the budget: profile generation
  (/api/scan/icp); TinyFish search/fetch (own caps); free sources (GDELT, job boards, SEC, site crawl); post-scan people
  search; autopilot and all outreach actions; monitors/watches and CSV imports (flags only); BYOK enrichment (switched
  off, not bounded); retries below dazl and real billing; the per-owner pool (in memory, resets on restart).

- b/scan-budget-ui (stacked on #216; fixtures only): optional spend limit on the profile editor, off by default (then no
  `budget` is sent). It builds the same budget object as the API (max_usd and the false-only flags) through the same
  validator, shows the partial-scope disclosure and the not-covered list BEFORE Run (above both Run buttons), disables Run on
  an unusable limit, and shows a server rejection. Still partial: it does not turn the scan into a whole-scan dollar ceiling.

- b/fetch-order (source quality; fixtures only): the ~16 fetch slots per scan (of ~80 results) are now ordered by how likely a
  page can still pass the window gate: dated inside the user's window, then undated, then dated outside it (can never pass),
  login-walled last; search order breaks ties and nothing is dropped when there is room. Not verified live.

- b/cost-bounds (cost-control gap after the deployed partial budget; fixtures only): for each path outside max_usd the
  disclosure now says what actually bounds it. Profile generation: one call, <= 800 output tokens, about $0.0xx worst case
  at the listed price (computed, unguarded). TinyFish search/fetch and the post-scan people search: bounded by COUNT (8
  searches, 16 pages per scan, 200 units per tenant per day, <= 5 people searches; defaults), not dollars; TinyFish's own
  pricing is unknown to dazl. A job that carries a budget no longer starts autopilot (its model drafting is outside the
  budget). Weekly watches can carry a budget that bounds each weekly run (not the watch in total). Still NOT bounded: retries
  and real billing below dazl, cache-token charges, reservations are estimates; the per-owner pool resets on restart; CSV
  imports take the flags only. max_usd remains a reservation limit on guarded model requests, not a whole-scan dollar ceiling.

- b/evidence-purge (follow-up to #222; fixtures only): audited, tenant-scoped operator purge of copied evidence for deletion requests
  (dry run by default; ordinary UPDATE/DELETE stay blocked; 410 `purged` and honest labels afterwards; SQLite only).
- b/design-tf-text (#222; fixtures only, no live run): the NARROW blocked-source path is built and designed in
  docs/design/blocked-source-verification.md. A candidate whose own fetch was blocked_by_site/needs_javascript is checked against
  the TinyFish text ALREADY fetched for the exact cited URL in the same scan attempt (canonical URL match, no redirects, wall/short/
  truncated copies refused, walled social hosts excluded), with every quote/company/date/window gate unchanged, labelled "checked
  against a copy fetched by TinyFish; dazl did not read the page directly" in the UI, API and CSV. The exact original TITLE and body
  are preserved in an immutable, tenant-scoped, hash-bound `lead_evidence_copies` row (90-day retention, 256 KB per copy, 300 per
  tenant) recoverable through GET /api/leads/evidence. CSV origin cells say only what is recorded (copy / unreadable / confirmed by
  you); blank claims nothing. Limits: SQLite-only table (deletion requests: see b/evidence-purge), English wall-phrase list, silent truncation
  undetected, no live-yield evidence.

## In progress (interactive Claude session, do not duplicate)

- Blocked-source verification: the narrow copy path is in review (#222); wider use waits for #188 data from a live run.
- Teams & access (#353, then #358, #357, #371): design in docs/design/workspaces.md. Increment 1 (workspace and
  membership tables, backfill, server-side resolution, role table) in review; next: route-layer tenantId/role checks,
  then invitations, member management and switching.

## Next (in order, for the scheduled builder; nothing business- or place-specific)

1. Decision-maker sources beyond the company site: officers named in SEC Form D filings (US), GitHub org members for
   software companies. Stored as person enrichments with the source URL; ranked by the scan ICP roles (rank.ts).
2. New intent signal: people opening issues on or starring competitor GitHub repos when the tenant lists
   competitors; public GitHub API only.
3. Self-hosted SearXNG as a third free search backend (env flag, off by default), same shape as lib/search/news.ts.
4. Production: Outreach page chunk-load failure (README "Current state").
