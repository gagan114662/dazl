# dazl status

Updated by Hermes on main after each merge. Newest first. Branches must not edit this file (it was the recurring merge conflict).

- #1095 c/1095-trial-boards (Refs #1095; merged to main as f26dbda0, PR #1155, Hermes-PC): a free-trial request for a US city now reads the public job boards, and a dated posting from a company's own board proves the requested role. City place (`lib/sources/jobboards.ts`): a city is read only right after "in", "near" or "around" ("account executives in Austin, TX" is Austin); any other "<Words>, <State>" keeps main's state place ("Dentists, Ohio" is Ohio). Profile place (`lib/scan/runner.ts`): when the request names no place and the profile names exactly one, only the board source reads the request with that place appended. Role proof (`lib/scan/sales-hiring-gate.ts`): the lead's own Greenhouse / Lever / Ashby posting passes the sales-hiring gate when the board dated it inside the window and the board record's title IS the requested role by shape (before it only level or segment words, after it the end, a separator or a level); "Team Lead, Account Executive", "Account Executive Manager" and "… Talent Community" are held, and the quoted sentence no longer decides. Real-data proof on this code: the real board source read the live boards on 2026-11-13 for staging job 3b417870's four candidates — 5 postings, 5 passing the role + 30-day rule, against 0 on the probe of main's code; and a local run of the real scan runner against the live board APIs gave 2 source-checked leads (NinjaOne, AlertMedia, both dated by Greenhouse) where main had 0 ready. NOT verified: **0 approvable leads** in that run ("Can't approve yet": buying need "hiring trigger only", actionability not graded — the grading step is a model call and was replayed, not run), no scan with a real model on this head, and no staging run. The staging check (Hermes, after deploy) must show at least one lead with Approve enabled and a named contact with a published address; until then #1095 stays open. Known limits, all safe but they drop real postings: the title rule holds about a third of real account-executive postings (#1185); a posting listed in two states or "Austin, TX or Remote" is refused; "Austin TX" without a comma is not read as the city; a capitalised non-city right after "in" is read as a city, a regression from main tracked in #1171.

- #1140 cc/1140-prod-deploy-v2 (Refs #1140, item 4; Hermes order): the production deploy scripts the box really runs are now in `ops/prod/` as the reviewed source of truth, byte for byte from the box: v2 `deploy-prod.sh` (424 lines, sha256 be319e30), `run-release.sh` (ea5a8de8) and the unchanged `pull-release.sh` (029301ea). main's old 286-line v1 script is not what runs: it moves to `ops/prod/legacy-v1/` as a test driver that refuses to run outside tests (it still exercises pull-release.sh end to end, 52 tests). New `test_prod_v2.py` (28 tests): the box copies are pinned by sha256, none of the three builds or installs anything, and the refusals v2 makes before it changes anything run for real in a sandbox. New read-only `ops/prod/check-installed.sh` fails, naming the file, when an installed script differs from the repo's. Nothing is installed on the box. Not exercised: v2's blue/green switch, which needs the real host (systemd, ss, /proc, Caddy and the real /etc/caddy/Caddyfile guard). Merged to main as ea4b3fe7 (PR #1187, Hermes-PC); #1140 stays open — no live check.

- #836 e/836-followup (stacked on e/836-shared-queue-live / PR #1161; the five findings of the automated review of 2026-11-13 20:03Z, and Hermes's decision of 17:12 ET): (1) `ops/staging/deploy.sh` keeps the scan worker stopped through the health gate and starts it only after the commit point (or once a rolled-back release is healthy), so a rollback can never erase the record of a paid call the worker made; `STAGING_STOP` / `STAGING_RESTART` now replace only the app's commands, the worker is still stopped around them. (2) Each kick copies a live scan's renewed claim time onto its queue item (`renewScanLeases`), so a scan running past the lease keeps its queue claim instead of being retried into dead-letter. (3) The shared queue never starts a pending scan that holds a reserved paid call: parked and ended `accounting_uncertain` like the in-process claimer, the bind refuses it, and the shared reaper now uses the same any-attempt rule. (4) A keyless pending scan is no longer work for the worker (no write every 5 s). (5) Decision: a graceful stop ends a scan it cannot hand back at once (`accounting_uncertain` with the paid call left recorded, or `timeout` on its last attempt) and closes its queue claim, so a deploy no longer leaves an account unable to scan for the 20-minute lease (only when the queue is on the stopping process's own store, as on staging; production runs with the flag off and has no queue item; with the queue on Postgres the claim still waits for its lease, because no other process can tell a scan a stop ended from one whose run is still going). A scan whose search had finished and whose post-finish stage was running at the stop has its claim closed the same way. With the flag off (the in-process claimer, no queue item) the scan row changes, and a trial scan's trial reservation is settled as the reaper settles it: the same outcome, 20 minutes sooner. NOT verified: on staging (needs #1161 merged and the box setup).

- #836 e/836-shared-queue-live (rework after Hermes-PC live check FAIL "not observable live" at 03f0e8eb: flag off everywhere, one worker, nothing in the store naming the worker): staging can now run scans through the shared work queue with two workers and show it. (1) A second worker: `web/scripts/scan-worker.mts` (`lib/scan/worker.ts`), a headless process (always named `worker-...`) on the same release, env and `DB_PATH` that kicks the same `kickRunner` every 5 s, only with `DAZL_SCAN_SHARED_QUEUE=1`; `ops/staging/dazl-staging-worker.service` (PartOf the app, 384 MB cap; peak under a real scan not measured yet), and `ops/staging/deploy.sh` stops it by name before the recovery point and starts it after the app. (2) Each claim records its instance: `work_queue.claimed_by` and `claim_log` (last 8 `{attempt, token, by, at}`; PG migration 0069, SQLite column add) plus `[shared-queue] claimed/settled/nothing to run` journal lines. (3) Found by running two real processes: store setup crashed a process starting beside another (`trigger ... already exists`, three DROP+CREATE trigger sites) - now one write transaction each. (4) Found on a production-shaped copy with the built app and the worker: a restart while a paid request is in flight is, by the existing rule, never re-run (`accounting_uncertain` after the lease), which is what an unprepared live restart usually hits; `DAZL_STAGING_SCAN_HOLD_MS` (staging only, test-only) holds a claimed scan before its first paid request so the hand-back path (attempt 2 on the other worker, finished once) can be shown on demand. Production unchanged: flag unset, no worker unit. NOT verified before merge: a real paid scan finishing `done` through the handoff (no provider key off staging; the local real-stack run used a key the provider rejects) - that is the staging check in `docs/STAGING.md` "Second scan worker". Needs on the box (Hermes, free): install the unit and the updated `deploy.sh`, set `DAZL_SCAN_SHARED_QUEUE=1`.

- #883 g/883-alert-once (alert once, deduped across plays): the alert dazl sends is the play-run mail, and "new" was decided per play, so a company play A had mailed was mailed again as new when play B found it, and counted again in B's "N new". New tenant-level record `play_alerts` (lib/play-alerts.ts; migration 0068; kept when a play is deleted, erased with the tenant): a weekly / daily play's run claims each new lead the Leads list shows in the transaction that sends its mail (so a company is held exactly when a mail naming or counting it goes out), and a lead whose company another run already holds is not new (`watch_new` cleared: not mailed, not counted on Plays). A company is known by its confirmed domain and by its normalized name, because production's own scans stored OpenRelay and Photon first without a website and then with one and they were mailed twice; two companies that share a name but have different websites stay two. The first play's leads are held by its automatic repeat (when dazl creates one; a play saved by hand first gets no repeat and holds nothing of the first play). A run that is not mailed (play paused or deleted before the mail pass, no confirmed address, outside the mail window) claims nothing and a failed send gives its claim back, so no alert is lost; one claim pass per tenant at a time (advisory lock on Postgres, taken before any row of the play). Limit: a company held by name only takes the first website a later lead gives that name. Monitors use the same record: a monitor does not alert an event for a company a weekly / daily play already mailed when that lead carried the same event (day and kind) or no date, a different dated event alerts once as new_signal, and a monitor's alert stops a play mailing that company; the monitor's own policy is unchanged. What main alerted before the record existed is read in once per account (every run the mail pass picked up, the first play's run, every monitor alert; oldest first, newest 5000 of each), so a company mailed before the deploy is not mailed again after it (review on PR #1162: the replay split at the deploy point went from 5 repeats to 0). A monitor knows a company under either key too: the same event under the other key continues on its own row (no second "new company", "now reachable" still alerts once). Real data (prod backup 2026-11-13, one tenant's 11 real scans replayed as runs of 3 plays): main mails 5 companies twice (3 named twice, 2 counted then named); this branch 0. Not verified live; the monitor leg cannot be seen live until #882's detector finding is fixed (no scan writes date_status 'verified'). Test: test/play-alert-once-883.test.ts (both engines, plus one run through the real scan runner).
- #1036 b/1036-review-lane-work-email (live check 2026-11-13 18:43Z: the button only showed after "Keep as research"): a lead still under "Needs your review" / "Research only" now shows Find work email for its buyer-role people when its website is settled (same component, same server lookup; lib/people/work-email-review-lane.ts). Not for rejected leads, non-company rows (author_post, counterparty_signal), fixture rows or an unsettled site. Finding an address never confirms the lead. Test: test/work-email-review-lane-1036.test.ts.
- #1036 b/1036-work-email-fixture (live-check enabler, Hermes 09:21): TEST-ONLY staging fixture lead so Find work email can be clicked through on staging at $0. `POST /api/leads/verification-fixture {"action":"work_email"}` creates ONE labelled lead (job/company say test only) on a settled site (`work-email-fixture.dazl-staging.test`, own-domain basis) naming five buyer-role people whose names drive the staging fakes: Valid -> checked, Catchall -> found not checked, Invalid -> mailbox does not exist (address hidden), Spamtrap -> do-not-mail (address hidden), Later -> stored found-not-checked with a Check mailbox button. A "create the Find work email fixture" control is on the test-account panel. Only on the designated test tenant with DAZL_ENV=staging, DAZL_STAGING_FAKE_PDL=1 AND DAZL_STAGING_FAKE_ZEROBOUNCE=1 (403 `staging_fakes_only` otherwise); a lookup on that lead runs only under the same gates, never calls Apollo, and runs the saved PDL key regardless of the Apollo-gated opt-in. DELETE with the same action removes it and its lookups. Test: test/work-email-fixture-1036.test.ts, test/work-email-fixture-route-1036.test.ts.

- #846 #847 c/846-prod-caps (Refs #721; Hermes-PC REOPENED 2026-11-13: no month cap on dazl.ai): every account now has a per-scan, a per-day and a per-month spend cap, never unlimited. Per scan: unchanged `DAZL_SCAN_CAP_CAD` (default and ceiling CAD 5; 0 or malformed refuses every paid scan call). Per account: its own entry in `DAZL_RUN_MAX_USD_USERS` (day) / `DAZL_OWNER_MONTH_MAX_USD_USERS` (month) wins; per day / per month for every other account: `DAZL_OWNER_DAY_MAX_USD` (default USD 10, ceiling 100) and `DAZL_OWNER_MONTH_MAX_USD` (default USD 100, ceiling 1,000). Owner decision: a value that is not a positive number (missing, 0, negative, Infinity, text) is ignored and the next source applies (account entry, deployment setting, built-in default), so nothing can mean "unlimited"; above the ceiling it is clamped. A named account keeps its PooledGuard path, with its other window now the deployment default (before: no month cap if only a day entry was set); every other account is reserved at the model transport in the scan cap's own transaction (inside a scan) or through ownerGuarded's account context (replies, drafts, sequences, SEO, qualification, website read), refused `owner_pool_limit` past a cap with nothing sent. Proof on a deployment with zero spend: `GET /api/internal/spend-caps` (operator secret as /api/internal/tick) reports each cap's number, its source and the real reservation code's refusal at it, simulated in a throwaway in-memory store. No migration. Review at 1d4de543: the free-trial website read (#1095) now also counts on the account caps; a model call with no scan or account context is refused (`no_spend_context`; named escape hatch `runWithoutAccountSpend` for offline evals and transport tests); reserve and settle lock pool rows before scan_jobs; settings are plain decimals and an account list's first valid entry wins; the ops check also fails when a configured model has no price. Not done: the pre-run estimate does not show the default caps yet (only a named account's).
- #1043 cc/1043-your-business (PR #1145): a "Your business" page shows what dazl knows about the workspace - the stored profile, Memory and Competitors, the same records every search and draft reads - with where each item came from (a link to the page on the user's own site for researched items), edits each in place (one editor at a time; a source that did not load gets no editor and never claims to be empty, so a failed read cannot be saved back as a blank profile), and suggests up to 5 one-click plays built only from what is saved. Review fixes (xhawk, this run): a saved buying signal is offered as a play only when `compileTargeting`/`planConditions` turn it into a positive condition, so a free-form signal ("attended a trade show") no longer makes a play that reads as signal-targeted and enforces nothing (such a workspace sees fewer plays); the competitor play is now ONE play naming every competitor the scan's complaint collector reads (up to 5, COMPLAINT_COMPETITORS pinned to MAX_COMPETITORS by a test; no play when the names would not fit in a query), and a signal with a known negating, stopping or shrinking wording makes no play at all, whatever the compiler read ("Business rejecting venture capital funding", "without hiring front-desk staff", "instead of hiring recruiters", "lost funding": none; a word list, not a guarantee). A hiring play also needs the signal to start with the hiring. A play only fills the search box on Leads - nothing runs or is charged until the user presses Find leads and sees the cost. Competitive: Gojiberry/Pancake ask the user to re-describe their business per search; dazl shows the stored understanding, its provenance, and plays derived from it. Left for follow-up: carrying a chosen competitor into scan scope as structured targeting (the collector would then filter to it); per-item provenance for the flat profile fields. Fixtures only; no live scan.
- #769 cc/769-tech-fixture (live-check fix, Hermes-PC PARTIAL at f6c697d7: no adoption, removal or outage could be shown live): TEST-ONLY staging technology fixture. With DAZL_ENV=staging only (elsewhere 404 to a member with the operate role, 401 signed out, 403 to a viewer), `POST /api/leads/tech-fixture {"page"}` serves the fixture company's homepage as plain / hubspot / consent_wall / challenge / outage_503 / home_503 and crawls it once through the real site crawl (only the fetch is local, reserved .test site); the answer lists the dated observations, the change rows, what this crawl added and a false-change count against the page actually served (fixture-only: not a false-positive rate on real sites). `DELETE` cleans up. The change rule itself is unchanged. Tests: test/tech-fixture-769.test.ts (also the 26 real staging observation rows of 2026-11-13 with the site names replaced: 6 repeat comparisons, 0 changes), test/tech-fixture-route-769.test.ts. Runbook: docs/STAGING.md. Not verified: on staging itself (after merge). Limit: the fixture page is handed to the crawl in-process, so the network fetch layer (DNS guard, redirects, timeouts) and the address/location identity checks are not part of what the fixture shows. Not in scope: real-world repeats (the prod dogfood play, 2026-11-12 decision). Seen on the way, not changed: the crawl's ledger line counts the changes its history still confirms, so an unreadable crawl after an adoption reads "observed thin_page: 0 technologies, 1 changes" although it wrote nothing new.

- #1037 b/1037-first-play-route (item 1, Hermes decision): both staging first plays stopped `unbounded_fallback_hold` with report.news null and zero searches because the news adapter was switched off (NEWS_SEARCH_ENABLED=0) and a first play had no other lead source. Now: whenever the news stage runs or is skipped on the no-lead path it records its status (`search:news` skipped_disabled / skipped_no_profile / skipped_no_model) and zero counts in report.news; when free news cannot serve a first play, the existing TinyFish lead search runs HARD-capped at DAZL_FIRST_PLAY_LEAD_SEARCHES (default and max 3) searches and DAZL_FIRST_PLAY_LEAD_FETCHES (default and max 6) page reads, inside the per-scan TinyFish cap and paid from the trial reserve on a trial; a first play where nothing could run stops `no_lead_source` (own copy), never a held fallback. A capped search whose every query answered zero hits ends `no_discovery`; hits it could not read stay held (never concluded). A free-trial play's fallback never plans into the trial reserve's last 25%. The cost estimate and the run-budget disclosure state the fallback. Test: test/first-play-route-1037.test.ts (both job shapes).

- #767 c/767-careers-quote (live-check fix, Hermes-PC FAIL on staging 194e9ada: the zapier.com careers lead was held `quote_unconfirmed`): a careers link to a public Ashby / Lever / Greenhouse posting is now quoted only from inside one of the posting's own text fields, the ones the verifier's board-record page renders (Ashby descriptionPlain, Lever descriptionPlain / additionalPlain, Greenhouse content), never across the `${title} ${description}` (Greenhouse also `company_name`) join. The quote must be the posting stating THIS vacancy: the posting as subject (we / we're / our ... team is / <company> is / join us / join <company> / join the team), hiring wording (hiring, looking for, looking to hire, seeking, recruiting), then the title or its core role (also its plural, and also without a leading Senior / Junior / Lead; a different level such as Junior on a Senior posting is another role) after at most three filler words, with no further role noun or hyphen compound after it; or "As our new <title>", "About the role: <title>", "we're hiring for the <title> role", and "We're hiring!" followed by the title. Customers or competitors "looking for", "Hiring an AE is hard", "a former AE", "AE Manager", "Sales Engineer" for title "Sales" and passing mentions give no quote. Lever lists[] bullets are quotable (the verifier renders them), and an unquotable posting does not hide a later quotable one on the same page. Greenhouse content is rendered with the verifier's own `htmlToText(decode(...))` (lib/scan/fetch-page.ts), so entities match byte for byte. With no quote the careers source offers no evidence for that posting (`quote_too_short`); the sales-hiring gate keeps main's result for the verified vacancy (no yield lost), only without a quote. Own-domain job pages keep the old title window. Second blocker found on the way: `hostBrand` read "jobs" from jobs.ashbyhq.com, so Zapier's own posting (a zapier.com/l/jobs/... link next to "using AI tools") would have been held `counterparty_signal`; a posting URL's brand is now its board org, the lead's own only when it equals the lead's whole company key or that key plus a board-slug suffix (hq, inc, labs, io, app, team, careers, jobs): "AI Corp" on the retail board and "Ramp" on rampart stay counterparties. Tests: test/careers-quote.test.ts (runner-level through runJob / verifyLeads for all three boards), counterparty, sales-hiring-gate #767. Not verified: live re-run of the zapier.com scan; with the request "hiring account executives" the sales-hiring gate may still hold a Sales Assist Representative lead for the requested role. Not in scope: the owner's matrix run / `recording_sha256`, and the low yield from JavaScript-rendered careers pages.

- #1126 c/1126-ats-identity (follow-up to #1117, Refs #533 #1107): a posting read through its board's API record is now published by the company the board STATES (Greenhouse company_name), and only without one by its slug. The Ashby job-board and Lever postings APIs state no company name: checked by reading one public board of each on 2026-11-13 (api.ashbyhq.com/posting-api/job-board/ashby, api.lever.co/v0/postings/leverdemo) and Greenhouse boards-api.greenhouse.io/v1/boards/airbnb/jobs, which carries company_name. Either names the lead's company only as its whole key (lib/scan/evidence.ts boardNamesCompany): board "acme-health" names "Acme Health", never "Health" or "Acme" alone; a stated "Zeta Labs" on slug "acme" names Zeta Labs, not Acme. Owner decision: a slug is matched by companyOwnsDomain's domain-label rule (separators removed, equal to the lead's key without spaces, 3+ characters, no legal-suffix stripping on the slug), so "macquarietechnologygroup" is "Macquarie Technology Group" and "acme-co" is not "Acme". The posting's job title never names the employer ("Salesforce Administrator" is not Salesforce). The slug is no longer in the page text or the title (title: "<posting title> @ <stated name>", else the posting title). The same identity is used by verifyEvidence, the job-feed intake, the source review, the runner's quote_unconfirmed routing and the own-block place check. A quote naming the company still verifies. Fixtures only; no live scan.

- #1129 c/1129-postcode-year: a New South Wales postcode 2000-2099 written as an address (a capitalised place name, "NSW", the number, and the address ends there: punctuation, a separator, "and <Place>", or a job-board header word such as "Apply" / "Hybrid": "Sydney, NSW 2000 / Melbourne, VIC 3000") is not read as a year, so an undated lead quoting a Sydney address is no longer held as event_date_stale ("the quote names 2000"). Only NSW is excluded: no other code has postcodes in the 1980-2099 year range, and "WA" is also Washington, so "Seattle, WA 2019." or "Adelaide SA 2018." stay years, as does a bare code ("NSW 2019 CONFERENCE") or any other follower ("Botany NSW 2019 Expansion"). Known limits (year hidden): "<Name> NSW 2019." ending a sentence, "<Place> NSW 20xx <header word>". Fixtures only.

- #533 c/533-live-fixes (live check FAIL at 1e250f76): the model's own wording "Posted a <role> role on Ashby/Lever" is hiring wording (scoreboard.ts HIRING_EN), so the board's first-published day now dates those leads; the record text carries the posting page's header fields in page order (Ashby: Location, Employment Type, Department; Lever: locations, department – team / commitment / workplace, "Apply for this job"), so a quote cut from that header is found; dated by the board, a postcode in the quote ("NSW 2000") no longer makes the lead stale. Tests use the exact live strings. Not done: identity when the quote never names the company and the board slug is the name glued together (#1126). Fixtures only; no live scan.

- #381 c/381-retry-on-zero (decision under the lane's delegation, 2026-11-13): the adaptive discovery round (one more bounded TinyFish round with genuinely different queries when round one verified no lead; PR #655) is ON by default for scans a person starts that may use paid steps (never a free-trial scan, never paid_fallback=false, never a scheduled watch/monitor run, which says skipped:recurring_run); DAZL_ADAPTIVE_DISCOVERY_ENABLED=0 turns it off. The price estimate's maxima and the budget disclosure now state its 3 searches, 6 pages and 1 extraction. Competitive: Pancake/Gojiberry keep searching until a run has leads; dazl gave up after one batch. Fixtures only; no live scan.

- #1036 b/1036-verified-work-email (stacked on #899 / PR #1119): Find work email is now the Apollo -> PDL -> free-tier verifier waterfall. An address Apollo or PDL found for a US person but did not verify gets the ZeroBounce free-tier check (only with EMAIL_GUESS_ENABLED, ZEROBOUNCE_API_KEY and EMAIL_VERIFY_DAILY_CAP; same per-tenant daily cap and monthly ledger as the scan's guess checks). Only an explicit "valid" shows it as "Checked work email" (who checked, when); catch-all / unknown / errors stay "Found, not checked" with the reason; "invalid" hides the address. The lookup's status stays the provider's ('unverified'); three additive columns record the check (migration 0064 after #899's 0063). Drafts still use published addresses only. Not verified live: needs the free ZeroBounce key on staging.

- b/staging-fake-pdl (Refs #382 #1036; Hermes: live checks without sign-ups): TEST-ONLY staging fake PDL. Only with DAZL_ENV=staging AND DAZL_STAGING_FAKE_PDL=1 (inert in production): PDL person search and person enrich answer locally, deterministically, in PDL's response shape (a person named "Staging Testperson" on the lead's own domain; a self-evidently synthetic US work email staging-first.last@site for Find work email; a lead domain containing "wrongco" gets a person at another company, so the agreement rejection shows live), so every real gate after the call (spend cap, credit pool, claims, company agreement, US rule, role match) runs. A tenant saves any string as its PDL key to enable the provider.

- #1037 b/1037-staging-trial-no-google (item 3, stacked on #1120): TEST-ONLY - with DAZL_ENV=staging, DAZL_STAGING_TRIAL_NO_GOOGLE names exact test email addresses whose free trial skips ONLY the Google prerequisite (every other trial gate still applies), so a brand-new password account's first play can be live-checked on staging. Inert outside staging; the product truth record's google_account requirement stays true for real accounts.

- #402 b/402-trial-requires-google (live-check fix item 1): the product truth record's `feature:trial_scans` and `feature:trial_site_read` now say `requires: ['google_account']`, taken from `TRIAL_REQUIRES` in lib/billing/trial-budget.ts, the same list the trial gate enforces (`google_required`), so a password-signup prospect is never told the trial needs no setup. A launched autopilot whose policy is bound to an older record is no longer calibrated (`launchGate`): it stops and pauses until the owner accepts the current record. **Deploying this PR, or toggling an env value the record reads (trial key / trial site-read cap / Stripe checkout), pauses launched autopilots until re-acceptance** - fail closed, by design. Not in this PR: item 2 (live enforcement needs AUTOPILOT_ENABLED=1 on staging, or test-tier acceptance).

- #382 b/382-refusal-reasons (follow-up to merged #1113; its last commit missed the merge): the scan view shows one 'not tried' notice per spend-refusal cause (a scan pass refused as accounting_uncertain and an owner retry refused as over_cap are two lines, each with its own reason), and a test pins the run report for an Apollo timeout followed by refused PDL lookups (1 unconfirmed, 1 failed; refusals not counted).

- #1042 c/1042-daily-repeat (decision by Hermes for Gagan, 2026-11-12: daily, not weekly): the first play's automatic repeat now runs every day ("next search tomorrow"), on every plan. Free plan: at most 1 scan a UTC day per account, failed ones included (a day it already scanned is skipped, moved to the same time tomorrow, recorded as an audit event and said on Home and Plays), and a run on the free trial is held to $0.30 (run_budget.max_usd; own-key runs keep no added budget so Autopilot still drafts their leads); the existing trial caps still apply on top. Paid plans: their quota only. Hand-made "Watch this weekly" plays stay weekly. Repeats created weekly before this deploy are pulled in to a day after their last run on the next tick; a repeat created by a late tick keeps the first play's time of day; the skip notice stays until the play runs again. No migration (cadence read from the repeat's existing marker). Competitive: Pancake/Gojiberry find new leads nightly / every 2 h; dazl's first play now does daily. Fixtures only; no live scan, PG leg in CI.

- #533 c/533-ats-posting-record (live check 2026-11-12: two Ashby postings for the requested role held "blocked_by_site", undated): a posting URL on Ashby, Greenhouse or Lever is now read through the board's own public API record (lib/sources/ats-posting.ts), never the page, as lib/legal/policy.ts already promised. The record gives the title, location, text and the board's first-published day; a hiring candidate cited to exactly that posting is dated by it (ats_structured, the #460 contract). A posting the board no longer lists is "not found"; a refused or malformed answer is a failed read and is never sent to the render service. Competitive: Gojiberry dates every lead's "Just hired" window; a requested-role posting is now a dated lead instead of held. Not done: binding a company domain from the board slug. Fixtures only; no live scan.

- #1037 b/1037-first-play-truth (live-check item 2): the first play's cost panel no longer says "Free sources only ... No TinyFish search or fetch" / "no ... post-scan people search". The estimate shows a "People search (who to contact)" row (TinyFish, at most DAZL_FIRST_PLAY_PEOPLE_SEARCHES, default 10, one per ready lead naming nobody; no row when people search is off) and the run-budget note says the same; a free-trial (non-first5) estimate counts the first-play people cap (10), not the ordinary 5. Cap moved to a pure module (lib/people/first-play-cap.ts) so client-bundled disclosure code can state it. Not in this PR: live-check item 1 (first play stopping with unbounded_fallback_hold before the people step).

- #382 b/382-waterfall-in-scan (live-check fix, Hermes-PC FAIL on staging 223b3a4b): inside a real scan an Apollo 401/429 no longer blocks PDL. A documented rejection by a BYOK enrichment vendor (Apollo, PDL) now stops only that vendor for the attempt (`lib/scan/spend-cap.ts`); model/TinyFish/render rejections and every maybe-billed failure (timeout, 5xx) still stop all paid calls. A lookup the spend gate refuses before sending is recorded as `spend_refused` with its reason ("People Data Labs not tried ...") and its claim is released, not held for "Retry unavailable"; a circuit opened by one rejected key says "after the saved key was rejected". Side effect fixed: an Apollo rejection used to also block the post-finish people search and buyer-fit model calls of that scan. Competitive: a tenant with both keys gets the PDL contact Gojiberry-style enrichment promises when Apollo is down or rate-limited. Not verified live: needs a valid PDL key on a staging tenant (PDL free tier).

- #1065 b/415-same-thread-dsn-ref review fix (xhawk High): when two sent rows share a Gmail thread, a DSN that exactly references the sibling row is left unlogged by the row scanned first, so the referenced send (or phase 2) suppresses it instead of the notice being consumed. Competitive: a permanent bounce can no longer slip past suppression (sender reputation). Fixtures only; no live Gmail.

- #763 (Norway registry, branch kabir-763-1794340503): brreg leads now cite the entity's own API record (data.brreg.no/enhetsregisteret/api/{enheter|underenheter}/{orgnr}), which states
  registreringsdatoEnhetsregisteret, so the unchanged verifier dates them (`page_bound`). The verifier's page fetcher reads that one JSON record URL shape and nothing else. A Norway task
  (`norway-dental-registry`, brreg only) is on the scoreboard, outside frozen benchmark set v1. Not verified: a keyed scoreboard run (TINYFISH_API_KEY, SCOREBOARD_ANTHROPIC_KEY); registry
  brreg now spends one record read per cited item from the shared 60/hour cap (up to 12 calls per scan, about 5 full scans an hour process-wide). Registry
  records carry no email/phone, so a Norway lead still needs enrichment before it can be qualified.

- #899 b/899-free-mailbox-verifier (Hermes decision 2026-11-12: free tier only): ZeroBounce's free tier is wired as the mailbox verifier (`lib/people/zerobounce.ts`) when `ZEROBOUNCE_API_KEY` is set; the scan runner's last post-finish step (`verifyJobCandidates`, traced `email_verify`) checks the scan's high-confidence US guesses with the existing capped `verifyCandidates`; the crawl itself is unchanged. New monthly cap per database = the free allowance (100, `EMAIL_VERIFY_MONTHLY_CAP` can only lower it), kept in an operator ledger (`email_verify_usage`) that tenant deletion leaves alone; the provider's own refusal is the backstop, on top of the per-tenant daily cap (`EMAIL_VERIFY_DAILY_CAP`, still 0 by default). A bad key / no-credits answer stops the run; only "valid" verifies, catch-all never does. Migration 0063 (ledger + index; 0062 is #1096 on main; renumber at merge if another lands first, see ~/work/migration_claims.txt). A bad key / no credits / 429 stops the scan's remaining checks. Privacy text names ZeroBounce. Not yet: showing a verified guess in Find work email (#1036 follow-up, needs a work_email_lookups schema change). Not verified live: needs a free ZeroBounce key on staging.

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

## In review (SEC officers)

- b/sec-officers: executive officers/directors named in the SEC Form D filing already matched to a lead are stored as `person`
  enrichments (connector `signals:sec-form-d`, source = the filing, labelled "as of filing, not verified as current") and flow into
  the existing right-people ranking / Best Person CSV column. Free, US-only by nature of Form D, no email derived, no address kept.
  Competitive: founder/CEO names for funded companies whose site lists nobody (Gojiberry-style founder contact, no paid API).
  Left for follow-up: GitHub org members (Next #1b). Fixtures only; no live EDGAR call.

## In review (owner goal: better than Gojiberry/Pancake at finding leads for any business, any geography)

- #186 b/buyer-fit-gate: a job posting alone is not a qualified lead (home-page fit evidence, multilingual hiring).
- #187 docs/process-instinct-merges: PROCESS (Instinct merges, design items), this STATUS.
- #188 b/verify-provenance: diagnostic, did TinyFish have text for pages the verifier could not read.
- #189 b/design-email-finder: DESIGN note, needs owner answers (verification server, US rule details).
- #190 b/email-pattern: email format inference, unverified candidates in own tables, off by default.
- #191 b/dm-icp-rank (on #190): buyer roles first per site; buyer titles derived from the scan ICP (no fixed list).
- #192 review fixes (greptile P1/P2): the LinkedIn stop cooldown is now checked before EVERY reservation in both the people reader and `collectAdvanced` (shared `coolingDown` in lib/advanced/request-budget.ts), so a run in flight when another run is throttled sends no further request and spends none of the shared hourly budget; `checkTransportContract` now also aborts a call mid-flight and fails a transport that keeps running or starts a request after the abort. Fixtures only.
- #192 b/linkedin-people: LinkedIn engagers + people search via the tenant session (owner decision), not live-tested.
- #193 b/people-search (on #191): right people from public profile search results; Right people UI shows them.
- #194 b/extraction-yield: markdown-free evidence, one verbatim passage per company.
- #195 b/news-search: free Bing News RSS beside TinyFish and before paid research.
- integration/all-open: all of the above merged, for one scoreboard run (not for merging).

## In review (code fixes only)
- c/1127-ats-recheck (#1127, follow-up to #1117 / #533): the evidence recheck dates a hiring lead by the board's own first-published
  day for exactly its posting URL (proof `ats_structured`, the verifier's rule; a non-hiring lead or another day never takes it), and
  ATS board record reads are bounded to ATS_RECORD_CONCURRENCY = 2 at a time per scan (lib/scan/ats-read-slots.ts; reads outside a scan
  are not bounded; the process-wide Ashby board memo can make one scan wait in another's queue for a shared board). Overlaps #1143 (c/1126-ats-identity) only in fetch-page.ts, on different lines. Not verified: a live scan.
- #943 b/914-timing-proof-revalidate review fixes: resolution, completion and the scoreboard now read the same `currentSiteContact` rule as actionability (a populated but unconfirmed domain, or a contact from another site, no longer counts as identity/contact/qualified), and contact selection is order-independent. Competitive: benchmark and completion numbers can no longer be inflated by leads the live gate rejects. Fixtures only; no live scan.
- b/402-claims-capability (#402): product truth record built from code/flags (lib/product-truth.ts, versioned hash); a launch
  policy that binds it holds drafts promising unshipped channels/integrations, unpublished prices, unbenchmarked
  comparisons, no-fit prospects, or copy prepared under a changed record; polish refuses such rewrites; buyer answers
  from the record. Not done: per-tenant truth records for other products, UI to bind/accept it, public pricing/support page.
  b/402-source-truth: sources whose adapter is not built (PLATFORM_SUPPORT: Facebook, XiaoHongShu) are unavailable, not
  limited behind an operator worker; record version moves, so drafts/answers bound to the old one are held until re-accepted.

- b/363-spend-reservations (#363, part): persistent workspace day/month credit pools for BYOK Apollo/PDL enrichment
  (scan waterfall and commenter import) - reserve before the call, settle to the proved charge, fail closed; still open:
  scan-runner settle, per-play caps outside scans, cost disclosure UI and threshold/stop events (web/docs/spend-safety.md).
  Review fixes (Instinct 2026-11-05): NO default limits any more (unset = per-scan caps only; usage counted); limit is a
  per-workspace explicit setting (Settings > Enrichment) with an operator-wide env fallback; credit_cap/credit_unsaved now
  show in the scan view and Settings (provider, window, used of limit, where to change it); PG twins enforced by DAZL_REQUIRE_PG.
- PR #568 b/359-lifecycle-flow (#359 part 2): authenticated, audited request flow for tenant export/deletion
  (session-scoped routes, owner+fresh-auth delete with explicit opt-out policy and resume, viewer+fresh-auth
  export), the settings completion UI reporting retained exceptions, and operator list/resume/reapply controls
  (dry-run default), and the off-database tombstone ledger writer (DAZL_TOMBSTONE_LEDGER; deletion refused while
  unset) with the RECOVERY.md re-apply step. Real-route tests through the session loader; B byte-equivalent; a
  restored pre-deletion copy re-applied from the route-written ledger. No live run yet.
- b/404-acquisition-metrics (#404): owner-only `GET /api/growth/funnel` (`lib/growth/funnel.ts`) reports dazl's own
  prospect -> qualified conversation -> signup -> usable result -> repeat -> paid -> retained funnel from recorded events
  (no analytics vendor, no migration); Stripe `charge.refunded` now lands in the audit trail. Off until
  `DAZL_GROWTH_TENANT_ID` names the growth workspace. Synthetic cohorts only; cost prices recorded model tokens (scans, drafting, qualification) and stays a lower bound (enrichment credits are not converted).

- b/535-legal-policies (#535): Terms and Privacy pages render one checked text (`web/lib/legal/policy.ts`), still
  DRAFT; `test/legal-policy.test.ts` fails if a stated retention, provider, API host or opt-out behaviour drifts from
  the code. Owner/counsel items stay bracketed on the pages (NEEDS GAGAN list in the PR). Sign-up links both pages.
- b/355-fair-reply-sync (#355): reply reading is bounded and checkpointed per thread (due sequence/follow-up
  threads always read; background capped per call, oldest first; success recorded as of the oldest read). With
  `DAZL_SCAN_SHARED_QUEUE=1` (default OFF, deploy-time switch) scans run on the shared work queue, round-robin with
  at most `SCAN_PER_TENANT_MAX` (1) claimed per tenant, kicked every tick; a restart hands queue claims back. Tick-level
  multi-tenant load test with a default-off control. Migration 0047 (Instinct's order: this PR keeps 0047, #600
  renumbers).
- b/360-offhost-dr-proof (#360): retention (off until BACKUP_RETENTION=1), encrypted secrets/config bundle with its own
  key (master key excluded), replacement-host restore drill + separate key drill with dated RPO/RTO report, send gate,
  config/key-drill monitoring; CI runs the whole host-loss path on synthetic data. Live drill is Instinct's (RECOVERY.md).

- b/369-server-pagination (#369 follow-up to #425): Inbox and Outcomes share one needs-owner rule
  (`lib/outreach/needs-owner.ts`); since #415 the server counted bounce_review threads but Outcomes dropped them, so the
  Outcomes tile and Inbox "Needs you" total disagreed. Synthetic fixtures only; #369 stays open for the deployed check.
  b/369-test-fixture-harness: a test-only, NO-SEND Inbox fixture (POST/DELETE `/api/outreach/inbox/fixture`, owners of
  the `OUTREACH_TEST_TENANT_ID` tenant only, OFF unless `OUTREACH_INBOX_FIXTURE=1`) seeds 120 labelled threads plus one
  bounce_review notice so pagination and bounce_review can be checked live; cleanup removes only those rows
  (web/docs/inbox-fixture.md).

- b/354-pg-auth (#354, area 1 of the porting order): sign-up, sign-in, verification, reset and the Google callback reach
  the #417 conversion boundary on the Db layer, and `lib/auth-db.ts` has no raw-handle code left (its sync profile
  readers are gone; their callers read through Db). The store opener and the auth schema's SQLite half moved to engine
  file `lib/db/sqlite-store.ts`. `RAW_SQLITE_MODULES` 137 -> 131. Postgres-only fixture: `test/pg-port-auth-routes`.
  #354 stays open: 131 modules, two-instance and rollback criteria remain.

- b/354-pg-leads-routes (#354, area 2, first slice; stacked on b/354-pg-auth): the leads evidence, source-metrics,
  page-signals and domain-review routes run on the Db layer (`getDb()`), with Db-layer twins `evidenceCopyForLeadDb`,
  `evidencePurgedAtDb`, `setDomainReviewDb`; `sourceMetrics` and `leadSignals` take a Db. `RAW_SQLITE_MODULES`
  131 -> 125. Postgres-only fixture: `test/pg-port-leads-routes`. The other 17 leads/scan routes still call sync
  `lib/scan`/`lib/outreach` code (runner, crawler, enrichment, qualification, currentness gate, fixtures) or need an
  insert_seq migration; blocker per route on #354. #354 stays open.

- b/354-pg-auth (#354, area 1 of the porting order): sign-up, sign-in, verification, reset and the Google callback reach
  the #417 conversion boundary on the Db layer, and `lib/auth-db.ts` has no raw-handle code left (its sync profile
  readers are gone; their callers read through Db). The store opener and the auth schema's SQLite half moved to engine
  file `lib/db/sqlite-store.ts`. `RAW_SQLITE_MODULES` 137 -> 131. Postgres-only fixture: `test/pg-port-auth-routes`.
  #354 stays open: 131 modules, two-instance and rollback criteria remain.

- b/352-zero-ready-recovery (#352): a customer-mention hold (counterparty_signal) now gets the same bounded automatic
  same-company press search as blocked/undated holds (cap 3, same verifier, skipped when the run disables the paid
  fallback); Home's research-only state and the Leads research section show what that pass tried or why it did not run,
  and never ask the user to check or confirm. Stubbed fixtures only; not verified live.
  b/352-checkable-review: Home, the Leads card and the draft gate now agree for every hold reason (checkable-evidence
  and date-vouch holds are review; sales_hiring_check_failed is research on all three). Trial scans are unchanged: no
  recovery pass and no extra paid call (paidFallback stays false). Stubbed only.

- PR #455 fresh port (#359 part 1, tenant export and deletion lifecycle): `exportTenant`, the five-step resumable
  `deleteTenant`, the recreation guard (two generated triggers per guarded column on both engines, PG migration 0039)
  and the tombstone ledger functions. No request flow or UI in this part; the ledger writer and the recovery-runbook
  step are part 2. Council rounds 1-3 and probe fixes are in the ported head 277a5ec7. Guard table list is derived
  from the live schema, so tables main added since the fork are guarded automatically; the scope registry carries
  main's lifecycle_events / preview_claims / preview_claim_events entries.

- dazl-takeover/b/444-trial-site-read (#552, for #409): "read my website" on the free trial for a keyless account, one
  bounded read at a time on dazl's key (explicit operator ceiling, per-read $0.05 wallet reservation settled to the
  provider-reported cost in full, three reads per account per 30 days, priced-model-only spend guard; the worst priced
  call is $0.0486 with the guard's 1,000-token input margin, under the reserve), with the honest reason and the manual
  profile when it cannot run. Own-key reads stay on the owner's spend pool (#363). A failed or unreported read settles
  at its full reserve and ends; a never-settled read counts in full against its admission day's ceiling and stays on
  the account (the 1h grace bounds only the cross-day day ceiling). The served model and usage are provider-reported:
  a trust residual, not a proven cap. The funded path stays OFF until DAZL_TRIAL_SITE_READS_PER_DAY is set; enabling it
  is a new paid step that needs the owner's explicit approval (the trial pool names scans only). Migration 0037.

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
- PR #567 b/534-frontend-baseline (Refs #534): axe/keyboard/overflow check on 9 pages x desktop + EMULATED iPhone 13/Pixel 7 and served-HTML metadata check (web/docs/FRONTEND-BASELINE.md); physical-device, screen-reader and live social-preview checks not done.

## In progress (interactive Claude session, do not duplicate)

- Blocked-source verification: the narrow copy path is in review (#222); wider use waits for #188 data from a live run.
- Teams & access (#353, then #358, #357, #371): design in docs/design/workspaces.md. Increment 1 (workspace and
  membership tables, backfill, server-side resolution, role table) increment 2 (routes use tenantId, role check
  on every non-read handler) and increment 3 (invitations, members, switching, Settings > Team) in review; then
  #358 increment 1 (session inventory, revoke one/all, bounded reaper; docs/design/sessions.md) and
  increment 2 (fresh authentication for secrets, billing and member changes) in review; increment 3 (offboarding:
  removal revokes the member's sessions acting in that workspace and their pending invitations) in review (b/358-offboarding);
  #357 increment 1 (email verification, password reset that signs out everywhere, verified email to join a
  workspace; docs/design/email-ownership.md) and increment 2
  (change email, explicit Google linking) merged; finish (Pro checkout needs a verified email, acceptance tests
  mapped in the design doc; email confirmation before app access, so signup no longer reveals existing accounts)
  in review; next: #371.
- Audit trail (#371, part): design in docs/design/audit.md. Append-only `audit_events` (PG 0041), events for
  credential, billing, Stripe plan, sending, CRM, pipeline, consent, export, deletion, team and device actions, Settings > Audit
  trail and `GET /api/workspace/audit` (owners and admins; CSV). Automatic deletion is off: the tick purges nothing
  until the owner chooses a retention period (`AUDIT_RETENTION_DAYS`). Support access needs an owner decision.


## Finish before new work (Instinct's 2026-11-02 verification after the zombie-PR cleanup: #455/#444/#467/#463/#464
closed, their code shipped via #554/#552/#553/#556/#557, but none of the five issues below is fully verified
complete — do not start new issues until each is closed or explicitly re-queued with what's still missing)

1. #359 (tenant export/deletion lifecycle): export/deletion code shipped (part 1, ex-#455/#554). Part 2 in
   review (PR #568, b/359-lifecycle-flow): the request flow (GET scope inventory, POST export, POST delete with
   policy choice + resume), the settings completion UI with retention exceptions, and operator controls
   (scripts/tenant-lifecycle.mts list/resume/reapply), the tombstone ledger writer. Missing: live acceptance on a
   disposable tenant, DAZL_TOMBSTONE_LEDGER set on the host (ops/backup now copies it off-host), the owner's retention decisions.
2. #409 (trial-funded site read): code shipped (ex-#444/#552) behind `DAZL_TRIAL_SITE_READS_PER_DAY`, OFF by
   default. Missing: turn it on in a live setting and verify the first-useful-result-without-BYOK promise actually
   holds. b/409-activation-funnel: every website read is now recorded (`onboarding.site_read` audit event: path,
   result, reason) and `scripts/activation-report.mts` prints the funnel, drop-offs and time to first verified lead.
3. #405 (calibrated launch / preflight): code shipped (ex-#467/#553) but inactive. Missing: activation, and proof
   the "no routine hand-approvals" journey actually works end to end.
4. #394 (agent evals / autonomous evaluation): the evaluation tooling shipped (ex-#463/#556). Missing: the complete
   evaluation contract and at least one executed autonomous evaluation proving it.
5. #371 (audit trail): most audit-event logging shipped (ex-#464/#557). Missing: remaining action coverage, and a
   live check that a readable audit record actually comes out the other end.

## Beat Gojiberry/Pancake (#393) — after the list above, in #393's own priority order

2026-11-02 audit: of the 16 issues #393 scoped as required to actually beat Gojiberry/Pancake, only #378
(scoreboard counts leads correctly) is closed — it fixes measurement, not the product. The other 15 are open
and nothing in targeting, retrieval, contacts or ranking has shipped. The benchmark itself (#372) has never
been run: `docs/STATUS.md` Score section above is last updated 2026-10-26, shows 0 verified qualified leads in
every recorded run, and `scripts/scoreboard.mts` has never run with a real key. There is currently no evidence,
formal or informal, that dazl beats either competitor. Work in this order (#393's own sequencing):

1. #379 multi-page seller research + source-backed buyer hypotheses (competitors' actual strength today).
2. #380 explicit AND/OR/NOT targeting with per-condition proof.
3. #381 adaptive discovery driven by actionable yield, not a fixed search count (one bounded adaptive TinyFish round when round one verifies nothing: PR #655, in review; stubbed providers only, not run live; ON by default since #1132 for scans a person starts (not trials, not paid_fallback=false, not scheduled play runs); DAZL_ADAPTIVE_DISCOVERY_ENABLED=0 turns it off - see docs/DECISIONS.md 2026-11-13).
4. #382 real Apollo-to-PDL enrichment fallback waterfall (per-lead per-provider outcomes, timeout/skip notices in the scan view: PR on `b/382-enrich-waterfall`, in review; stubbed providers only, not run live).
5. #383 buyer-role contact filtering before result truncation (in review: PR #566, b/383-buyer-role-acceptance — role filter before the page cap, former/assistant-to rejected, no person from a generic inbox, and verified-current vs search-result-only contacts on the owner definition, each pinned by the acceptance harness).
6. #384 separate published provenance from deliverability/person-route status.
7. #377 fit rationale separated from proof-backed timing (closes the ranking-quality loop). In review: b/377-fit-rationale-timing (durable versioned timing proof lifts the
   currentness hold only for proven event + confirmed domain + named person/published route; fit rationale on the card).
8. #385 rejection/outcome feedback improves future selection (in review: b/385-rejection-outcomes, docs/design/lead-feedback.md); #387 continuous event detection — compounding
   advantages, start once 1-7 ship.
   #387 in review: b/387-event-detection (monitor runs alert only on novel, dated, in-window, verified events: new company /
   new signal / now reachable, deduped across plays, per-monitor alert policy, latency and missed-run report).
9. #386 real lookalikes, #388 tested source coverage (in review: b/388-source-adapters, Norway business register adapter for new businesses and new locations; other regions and procurement evaluated and blocked, see the capability matrix), #389 technographics (in review: b/389-technographics, crawl-detected tech as an explicit targeting filter + dated added/removed change signal), #390 first-party signals (in review: b/390-first-party-signals, signed consent-gated endpoint for the tenant's own form/demo/account-level visit events as dated, deduped first-party leads; no IP resolution), #391
   multilingual, #392 API/MCP — by measured marginal yield, lowest priority. #386 in review: b/386-outcome-lookalikes (supplied customers +
   negatives -> held-out-checked features -> scan profile; supplied accounts never returned; docs/design/lookalike-discovery.md).
10. #372 run the actual benchmark (dazl vs Pancake vs Gojiberry vs plain ChatGPT, blind-reviewed, precision@5/@10)
    as soon as enough of 1-7 ships to make the comparison meaningful — not before, and not skipped after.

## Next (in order, for the scheduled builder; nothing business- or place-specific)

1. Decision-maker sources beyond the company site: GitHub org members for software companies (SEC Form D officers: in review, b/sec-officers). Stored as person enrichments with the source URL; ranked by the scan ICP roles (rank.ts).
2. New intent signal: people opening issues on or starring competitor GitHub repos when the tenant lists
   competitors; public GitHub API only.
3. Self-hosted SearXNG as a third free search backend (env flag, off by default), same shape as lib/search/news.ts.
4. Production: Outreach page chunk-load failure (README "Current state").
