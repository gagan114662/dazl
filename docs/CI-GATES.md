# CI gates (Gagan, approved 2026-11-16)

1. **Pre-commit** (`.githooks/pre-commit`): eslint on staged files, then tsc (`npm run check:unused`).
   Install once per clone: `git config core.hooksPath .githooks`.
2. **PR CI** (`web-ci.yml`, pull_request): lint plus only the tests affected by the changed files
   (`.github/scripts/affected-tests.mjs`), hard 5-minute budget per job. Shared plumbing changes fall back to the full suite.
   An over-budget run fails with "PR CI over the 5-minute budget"; open an optimization issue/lane for it.
   The no-closing-keywords check is unchanged.
3. **Post-merge** (`web-ci.yml`, push to main): the full suite on SQLite and Postgres. When both pass, the commit gets
   the `main-green` commit status and the `main-green` tag moves to it. Only green commits deploy. Red on main: fix forward.
4. **Prod deploy** (`prod-deploy.yml`, manual, input `sha`): refuses a commit without `main-green`; runs
   `ops/prod/deploy-prod.sh <sha>` on the box over SSH, which backs up the DB first, smoke-tests (pages + hydration)
   and rolls back automatically on failure; then one public acceptance pass. A PASS here is the live check: Quest closes the
   batch's issues with "Quest live check (prod <sha>): PASS". Needs repo secrets PROD_SSH_KEY, PROD_HOST, PROD_USER,
   PROD_KNOWN_HOSTS (optional PROD_DEPLOY_CMD, default `sudo /home/ubuntu/dazl-ops/ops/prod/deploy-prod.sh`).
