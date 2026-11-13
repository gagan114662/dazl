# NEVER-AGAIN

Read this first, at the start of every session (Claude Code, Hermes lanes, any builder). Each entry is a mistake that
already cost us: what happened, when, the rule, and how the rule is enforced. **Automated** means a script or CI job
stops the mistake on its own; **note-only** means only the reviewer stands in the way. A repeat of anything here is the
top escalation. Add an entry the same day a new mistake of this size happens, with its enforcement, and keep
`.github/scripts/never-again.test.mjs` passing (it checks every entry has these fields and every path cited exists).

Times are US Eastern unless marked Z.

## 1. Building on the production box

- **Mistake:** a deploy ran `npm ci` / `next build` on the dazl box (prod and staging share one 1.8 GB EC2 box). It ran
  out of memory and dazl.ai went down.
- **Date:** 2026-11-12 20:25 and 2026-11-13 ~09:12.
- **Rule:** nothing ever builds on the box. Builds happen on GitHub runners; the box only downloads, verifies and
  unpacks prebuilt artifacts.
- **Enforced by (automated):**
  - Production: `ops/prod/pull-release.sh` + `ops/prod/deploy-prod.sh` take the build from
    `.github/workflows/prod-prebuilt.yml`; `ops/prod/test_prod_prebuilt.py`
    (`test_the_deploy_script_contains_no_build_step`) fails if either script gains a build or install command.
  - Staging: `ops/staging/pull-prebuilt.sh` deploys the build from `.github/workflows/staging-prebuilt.yml`.
    `ops/staging/deploy.sh` now REFUSES its old default on-box build (what `dazl-staging-deploy.timer` or a hand run
    would do) before it fetches or changes anything. An empty `STAGING_BUILD` is refused like an unset one, and on
    the box the only `STAGING_BUILD` accepted is the prebuilt unpack step `pull-prebuilt.sh` passes; any other command
    (`npm ci`, `yarn`, `make build`, a wrapper script) is refused. Only the throwaway-machine e2e test may build, and never where a dazl box path exists.
    `docs/STAGING.md` installs and runs only the prebuilt units (a test keeps it from starting the refused ones).
  - `ops/test_never_again.py` tests that refusal and scans every deploy script (`ops/**/deploy*`, `ops/**/pull*`,
    systemd units) for build commands. It runs in `.github/workflows/release-preflight.yml` and
    `.github/workflows/never-again-gates.yml`.

## 2. Hand-run deploy with the wrong process mode (502)

- **Mistake:** a production deploy started the new release as a child of a plain `systemd-run` service, which killed
  it when the deploy exited: dazl.ai answered 502.
- **Date:** 2026-11-13 09:20 (14:20Z).
- **Rule:** one deploy script, no hand-run deploys. Every deploy runs a public smoke test and rolls back on its own.
- **Enforced by (partly automated):** `ops/prod/deploy-prod.sh` runs the health/smoke checks and switches back on
  failure, tested in `ops/prod/test_prod_prebuilt.py` (`test_rollback_*`). The v2 script that runs each release as its
  own supervised unit (`dazl-prod@<port>.service`) is installed on the box but is NOT in this repo yet, so "no hand-run
  deploys" is note-only until it is.

## 3. Closing issues on staging-only proof

- **Mistake:** issues were closed after a staging check (or a merged PR) while prod still showed the bug: #914, #915,
  #846, #847.
- **Date:** found 2026-11-13 (listed in the owner's brief that day).
- **Rule:** an issue closes only with a comment that has, on a line of its own, `Live check (prod 1a2b3c4d): PASS` and nothing
  after it - the deployed commit from https://dazl.ai/api/health (8 to 40 lowercase hex characters) in place of
  `1a2b3c4d`, which is only an example and is refused - and says what was checked on dazl.ai and what it showed.
- **Enforced by (automated):** `.github/workflows/live-check-gate.yml` runs on every `issues: closed` event and
  reopens the issue (first), then comments why, unless a repo owner/member/collaborator posted that line **with a real
  commit** ("prod staging", a placeholder or a branch name is refused), **with evidence beside it**, **as their own text**
  (not inside a quote - including the lines right after a `>` line - code, `<pre>`, or an HTML comment, so citing
  this rule does not count) and **after the issue was last reopened**. It decides
  on the issue as it is when the check runs, and anything it cannot read counts as no proof. Closing as "not planned"
  or "duplicate", or a `wontfix` / `duplicate` / `not-planned` label, is exempt. Logic and tests:
  `.github/scripts/live-check-gate.mjs`, `.github/scripts/live-check-gate.test.mjs`. Limit: the builder posts as the
  same GitHub account as the owner, so a false PASS comment would pass this gate; the reviewer's own ledger is the
  backstop.

## 4. False "fixed" / "READY" claims

- **Mistake:** PRs and issues were reported fixed or READY when the claimed behaviour did not hold: #1079, #1124,
  #1125, #885.
- **Date:** 2026-11-12 to 2026-11-13 (PRs #1079, #1124, #1125; #885 earlier).
- **Rule:** no READY without the self-review/reviewer checklist output in the PR and a repro that fails before the fix
  and passes after it, at the exact head.
- **Enforced by (note-only):** the reviewer refuses to merge without it; `CLAUDE.md` requires the full-stop flow with the
  exact head SHA, commands and output. No CI job can tell a true claim from a false one.

## 5. Tests only on synthetic data

- **Mistake:** a fix passed its tests built on made-up input and still failed on real prod wording: #1117.
- **Date:** 2026-11-12.
- **Rule:** every fix includes at least one test built from real prod wording or data (anonymised where needed).
- **Enforced by (note-only):** reviewer checklist.

## 6. "Fixes #N" closing keywords

- **Mistake:** a PR body with a closing keyword auto-closed an issue at merge, before any live check (#569).
- **Date:** 2026-11-02.
- **Rule:** write `Refs #N`, never `Closes` / `Fixes` / `Resolves #N`.
- **Enforced by (automated, not required):** the `no-closing-keywords` job in `.github/workflows/acceptance-gate.yml`
  fails on any closing keyword in the PR body or commit messages, and `.github/workflows/live-check-gate.yml` reopens
  any issue a keyword closes anyway. `main` has no branch protection or ruleset (checked 2026-11-13), so no check is
  *required*: a red check does not block a merge by itself. Making it required is a repo-settings change for the owner.

## 7. A new route missing from the route manifests

- **Mistake:** a new API route (#1146, `GET /api/home/results`) was pushed without its manifest entries; CI went red
  late in review.
- **Date:** 2026-11-13.
- **Rule:** every new API route goes into `web/test/tenant-isolation-manifest.ts` and every route or page into
  `web/lib/ops/routes.ts`, in the same commit.
- **Enforced by (automated, not required):** `web/test/tenant-isolation-manifest.test.ts` ("the manifest lists exactly
  the route handlers that exist") and `web/test/request-log.test.ts` ("the route list matches the route files under
  app/") fail on any unlisted route or page; both run in `npm test` in `.github/workflows/web-ci.yml`. Same caveat as
  entry 6: not a required check.

## 8. Silent nights and lanes that die without a verdict

- **Mistake:** no update for 10 hours overnight; work lanes died without posting a verdict, and their issues sat
  untouched.
- **Date:** several nights up to 2026-11-13 (owner's brief, 2026-11-13 10:18).
- **Rule:** an update at least every 2 hours while work runs; a lane that ends without a verdict is re-handed at once.
- **Enforced by (note-only):** reviewer/coordinator operating rule, outside this repo.

## 9. Repeat of entry 3: an issue closed on a check seen only on staging

- **Mistake:** #848 was closed and reported as proven on prod, but the refusal it needed (the spend cap refusing a scan) had
  only been seen on staging. On dazl.ai the check showed reserves and no refusal. It was reopened the same evening.
- **Date:** 2026-11-13, closed 18:54Z, reopened 20:26Z.
- **Rule:** every acceptance criterion must be triggered on dazl.ai itself. "The same pattern is on prod" is not proof. A
  staging PASS never closes an issue.
- **Enforced by (partly automated):** `.github/workflows/live-check-gate.yml` reopens any issue closed without the prod
  line of entry 3, posted after the issue's last reopen (so the earlier comment on #848 no longer counts). Whether the
  criterion was really triggered on prod is still the verifier's judgement: the verifier brief keeps staging PASS and
  prod PASS apart, and the coordinator's own close guard (outside this repo) needs a dazl.ai ledger line as well.

## 10. A production secret printed in a lane's output

- **Mistake:** a lane listed the box's crontab, and the production tick secret was in it in plain text, so the secret
  ended up in the lane's output.
- **Date:** 2026-11-13.
- **Rule:** no secret is written inline in a crontab or a systemd unit. Secrets live in root-only files, and nobody lists
  a crontab, unit or env file unredacted. The ops door shows env keys, never values.
- **Enforced by (note-only):** operating rule for lanes and the coordinator. Nothing in this repo scans the box's crontab.

## 11. A paid test on production while work was on hold

- **Mistake:** a paid check ran on dazl.ai (the #848 cap check, about $0.04) while the owner had said to hold, before
  the owner's go-ahead.
- **Date:** 2026-11-13, about 20:30Z.
- **Rule:** no paid test on dazl.ai without the owner's explicit go. Since the owner's approval that day, paid live tests
  are allowed up to C$10 in total: every paid test posts its cost and the running total, and work stops to ask before
  passing C$10. A task that does not name its spend limit and the running total runs free checks only.
- **Enforced by (note-only):** the coordinator's task files name the limit and the running total; the reviewer checks
  that each paid test posted its cost. Nothing in this repo meters spend on tests.

## 12. A hand write to the production database

- **Mistake:** to reach a spend cap during a live check, a verifier lane inserted one spend row for the dogfood tenant
  into the production database with `sqlite3` over ssh, and deleted it afterwards. No other tenant was touched. The
  method was never allowed: a hand statement skips every check the app makes, and a slip in it changes customer data.
- **Date:** 2026-11-13, about 22:20Z.
- **Rule:** production is read and exercised through the product only: the UI and the API, signed in as the dogfood
  account. Nobody runs a write statement against the production database by hand, over ssh or any other way. If a
  check cannot be reached through the product, stop and report it. Running one of the three owner tools that change a
  live database through the app's own code (`web/scripts/purge-tenant-evidence.mts`,
  `web/scripts/rewrap-master-key.mts`, `web/scripts/tenant-lifecycle.mts`) on production needs the owner's explicit order.
- **Enforced by (partly automated):**
  - In the repo: `ops/test_never_again.py` (`NoHandWritesToTheProdDatabase`) lists every script under `ops/` and
    `web/scripts/` that opens a SQLite database for writing, with why it may: backup and rehearsal copies, files it
    creates, staging-only scripts (which must refuse outside staging) and the three owner tools above. A new script
    that opens a database for writing fails the test until it is classified, and no script may call the `sqlite3`
    command line with a write statement. It runs on every pull request (`.github/workflows/never-again-gates.yml`).
    The deploy's backup step (`ops/prod/deploy-prod.sh`) is on the list as a copy: it opens the live database read-only.
  - On the coordinator's PC (outside this repo): a wrapper at `~/.local/bin/ssh` refuses an ssh command to the box that
    names `sqlite3` together with a write statement, unless every database it names is a staging one, and logs the
    refusal. **It only sees the command line.** A script piped on stdin, a write made from an interactive shell, or
    another program that opens the database gets past it. It is a tripwire, not a lock.
  - Nothing stops a person with shell access on the box. That part is the rule above.

