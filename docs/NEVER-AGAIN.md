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
    the box a `STAGING_BUILD` that is itself a build or install command (`npm ci`, `next build`, `npm run build`...) is
    refused too. Only the throwaway-machine e2e test may build, and never where a dazl box path exists.
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
- **Rule:** an issue closes only with a comment that has, on a line of its own, `Live check (prod 1a2b3c4d): PASS` - the
  deployed commit from https://dazl.ai/api/health (8 to 40 hex characters) in place of `1a2b3c4d` - and says what was
  checked on dazl.ai and what it showed.
- **Enforced by (automated):** `.github/workflows/live-check-gate.yml` runs on every `issues: closed` event and
  reopens the issue (first), then comments why, unless a repo owner/member/collaborator posted that line **with a real
  commit** ("prod staging", a placeholder or a branch name is refused), **with evidence beside it**, **as their own text**
  (not inside a quote or code, so citing this rule does not count) and **after the issue was last reopened**. It decides
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
