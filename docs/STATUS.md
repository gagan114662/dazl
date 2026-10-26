# dazl status

Updated by the builder on every branch. Newest first. Facts only: every line says what was measured, by whom, and what
was not. Proposals are labelled as proposals and are not decisions.

## Deployed

- Production runs main b1021694 (includes #207 opportunity card and #208 hard recency window gate), per Instinct's
  acceptance run of 2026-10-26. Anything marked "in review" below is NOT live.

## Live acceptance, 2026-10-26 (Instinct, ordinary app route, test tenant, two scans, no rerun)

Source: #204 comment 6428648964. Result: FAILED customer outcome, zero source-checked or email-ready prospects.
- NYC dental request (90 days, chains/software excluded, dated source + practice-manager contact): done, 55s,
  candidates 1 / verified 0 / needs_review 1 / dropped 0. The one candidate is a Facebook group post, blocked by the
  site, undated, no person/contact/domain. Stored in review.
- London request (10-50 employees, seed funding within 90 days AND sales hiring): failed `no_candidates`, 51s,
  candidates 0, other fields NULL (not measured zeros). Source ledger: TinyFish empty, Anthropic fallback empty.
  The generated profile had broadened seed to Series A (user removed it before Run).
- TinyFish tenant usage rose by 16 searches and 32 fetches across both runs.
- Not recoverable: model tokens, served model, charges and API-request retries for these runs (source stats were off,
  `scan_source_stats` had zero rows). An empty source log is not evidence of zero raw hits.
- Not determined: why the two searches yielded so little. No saved queries or raw hits exist for them. The builder has
  no access to the production jobs; no cause is claimed.

## In review (none merged; Instinct reviews and merges)

Code fixes for the findings above and from #204 / #198 / #191 / #206 reviews:
- #211 window counts: with an explicit window only a valid in-window date stays in `verified`; stale, undated, invalid
  and future dates are stored under needs_review with their own reason. verified + needs_review is unchanged. Existing
  scans are not backfilled. Fixture tests only.
- #212 #198: the card no longer says a legacy "verified" date was confirmed on the page (it is a claimed event day);
  saved-grade copy matches the saved fit/intent/action fields.
- #210 card-vs-createDraft consistency test (one mocked clock, malformed/invalid/future window fixtures) plus a
  `createDraft` change: crawl rows are read even when the contact is an email, so a contact equal to a weakly-sourced
  crawled address now needs the website review at draft time (approve/send already did).
- #213 profile generator: a stated funding stage is not widened (seed stays seed).
- #214 usage tracking: per-scan model requests (served model, reported tokens, failures), profile-generation requests,
  source stats on by default (`DAZL_SOURCE_STATS=0` turns off), status API `model_usage`, history view shows the viewed
  scan's query. No price is computed; retries inside the provider are not counted.
- #206 window-widen: notice moved out of the collapsed profile details, editor shows the edited window, rendered stubbed
  check `web/test/ui/window-edit.ui.mjs` proves editing starts nothing until Run.
- #191 decision-maker finder part 2: past, retired, negated and assistant-to titles cannot take buyer slots.
- #193 people search (stacked on #191) and #196 CSV best person (stacked on #193): merged with current main; #193 also
  has the attached-employer parser fix.
- Older, untouched: #188 (verify provenance diagnostic), #189 (DESIGN email finder, needs owner answers), #192
  (LinkedIn people: whether signed-in automated collection is permitted is unresolved, not an owner decision on record),
  #194, #195, and #121, #132, #133, #147, #153, #164, #175 (relevance not triaged; this file makes no merge/close claim).

## Known gaps (from reviews, not built)

1. Normal `POST /api/scan` reads no per-run budget (CSV import does). Existing owner cap guards are not a vendor-
   guaranteed dollar ceiling: research is refused as unbounded, `count_tokens x 1.2` is an assumption, and the owner
   pool resets on restart (#204 comment 6428242018).
2. People search drops ambiguous multi-employer profile lines; there is no separate research-candidate store.
3. No live end-to-end run of the card, draft, approve, send and CSV paths against one eligible prospect.
4. No scoreboard run on the full six-search set. The four earlier real-key comparison harness runs are not that run
   and do not support any superiority claim (Instinct, #204 comment 6427830596).
5. Proposal only, not a decision: baseline numbers come before any performance target. The owner chooses a target
   after baseline evidence; none is set.

## Merged (history)

#183-#188 search, scoreboard, decision-maker finder, buyer-fit gate, process docs; #190 email format inference (off by
default); #200-#203 identity/geo, recency window, copy, country codes; #205 quarantine; #207 opportunity card; #208 hard
window gate. Instinct reviewed and merged each.

## Next (one concrete task for the next run)

Review findings first (comments on the PRs above), then:

1. **Per-run cost control on the normal scan route** (Known gap 1). Validate and persist the narrowing controls the
   CSV route already accepts (`max_usd`, search/fetch caps) before queueing `POST /api/scan`; show which paid surfaces
   are allowed or refused (profile generation, search-query writing, extraction, judge, scoring, grounding, buyer-fit,
   fallback research); keep a budget stop distinct from zero leads; say plainly that reservations do not survive a
   restart unless they are persisted; refuse research when it cannot be bounded and show that this is not the same
   behaviour as an ordinary scan. Isolated no-network route and runner tests only. Do not call it a vendor-guaranteed
   ceiling.
2. Owner/Instinct action, not the builder's: after #214 is deployed, one authorized ordinary scan per customer request
   on the test tenant, then read `source_stats` and `model_usage` to see where NYC and London lose candidates. Do not
   change search or criteria until that data exists.
