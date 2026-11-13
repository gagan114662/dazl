# Deploying the Next.js app (web/) on the EC2 box

Run it as ONE Node process (in-memory rate limits and the in-process scan runner assume that).

## Env vars
Required (`/api/ready` answers 503 until every one is set and well-formed, so `ops/safe_launch.py` will not cut over without them):
- `DB_PATH` - SQLite file. Use a NEW path (for example /var/lib/dazl-next/app.db). Never point it at the old app's database.
- `DAZL_MASTER_KEY` - base64 of exactly 32 random bytes (`openssl rand -base64 32`). Encrypts customer API keys. Losing it makes stored keys unreadable. Do not rotate casually.
- `PUBLIC_BASE_URL` - https://dazl.ai
- `STRIPE_SECRET_KEY` - sk_test_ until you go live, then sk_live_
- `STRIPE_PRICE_PRO` - the Pro price ID (copy it from the Stripe dashboard)
- `STRIPE_WEBHOOK_SECRET` - whsec_ for https://dazl.ai/api/billing/webhook (or https://dazl.ai/api/stripe, the same handler)
Account deletion (#359): `DAZL_TOMBSTONE_LEDGER` - an append-only file outside the database and backup directories (for example /var/lib/dazl-ledger/tombstones.jsonl, app user only); keep a copy off-host with the backups (set the same path as `DAZL_TOMBSTONE_LEDGER` in `/etc/dazl-backup/env` and create the file empty at provisioning: `ops/backup/offhost-copy.sh` then ships an encrypted copy after every backup and `dazl-backup-check` alerts when it lags). Unset = the settings page refuses account deletion (503); export still works. docs/TENANT-LIFECYCLE.md.
Optional: `OPS_ALERT_WEBHOOK_URL` (https; receives each scrubbed error record, throttled; see `lib/ops/errors.ts`), `SENTRY_DSN` (https; the same records as Sentry events, throttled; `SENTRY_ENVIRONMENT` optional), `DAZL_SCAN_SHARED_QUEUE` (`1` claims scans through the shared work queue, `lib/queue/scan-claimer.ts`, and kicks the scan runner every tick; default off, see docs/PLATFORM.md), `SCAN_PER_TENANT_MAX` (1: with the shared queue on, how many of one tenant's scans run at once, 1 to 8), `SCAN_MAX_CONCURRENT` (3), `SCAN_RENDER_URL` and `SCAN_RENDER_TOKEN` (separate renderer container only), `DAZL_ANTHROPIC_MODEL`, `DAZL_OPENAI_MODEL`, `SCAN_STALE_RUNNING_S`, `SCAN_PAGE_TIMEOUT_MS`, `SCAN_LLM_TIMEOUT_MS`, `SCAN_MAX_AGE_DAYS`.
Not used in this release: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (Gmail is PR #13, separate).

## Deploying a prebuilt release (the box never builds)
The production box has 1.8 GB of RAM. **It must never run `npm ci`, tsc or `next build`**: on 2026-11-12 a deploy that built
on the box was OOM-killed during `next build` and dazl.ai answered 502 for about 6 minutes. Every release is built on GitHub
instead, and the box only downloads, verifies and unpacks it.
- **Build:** `.github/workflows/prod-prebuilt.yml` runs on every push to main, on a free GitHub-hosted arm64 runner (the
  box's architecture, Node 22), with production's public settings (`PUBLIC_BASE_URL=https://dazl.ai`, never
  `DAZL_ENV=staging`) and no secrets. It publishes `prod-next-<sha>.tgz` (`.next` + `.build-commit`),
  `prod-modules-<sha>.tgz` (`node_modules`) and, last, the manifest `prod-prebuilt-<sha>.json` (commit, arch, Node ABI,
  lockfile sha256, each archive's sha256, size and unpacked size) as assets of the `prod-prebuilt` prerelease, keeping the
  newest 5 commits. An older commit (a rollback beyond that): run the workflow by hand with `sha=<commit>`. That works
  for any commit on main, also one from before `ops/prod` existed: the manifest tool is taken from the workflow's own
  commit (a second checkout, `.prod-tools`), never from the commit being built.
- **Install (once, as root):** the deploy runs as root, so it only runs root-owned copies it alone can change:
  `install -d -o root -g root -m 755 /usr/local/lib/dazl-prod && install -o root -g root -m 755 ops/prod/deploy-prod.sh
  ops/prod/pull-release.sh /usr/local/lib/dazl-prod/` (both refuse to run from anywhere a non-root account can write,
  e.g. a checkout under /home/ubuntu). The app and `db:migrate` now run as `ubuntu`, never as root: give it the database
  once, `chown -R ubuntu:ubuntu /home/ubuntu/dazl-data /home/ubuntu/dazl-*-prod` (the database, its directory for the
  WAL files, and existing releases a root-run app wrote into; the deploy refuses, changing nothing, while the database or
  its directory is not writable by `ubuntu`). The run env file (`/home/ubuntu/dazl-pr16-run.env`) is read as plain
  `KEY=value` lines (one level of quotes; nothing is expanded or executed).
- **Deploy (the ops door, as root):** `/usr/local/lib/dazl-prod/deploy-prod.sh <sha>`; one deploy or rollback at a time.
  It first removes release directories nothing needs (see Disk), checks free disk, copies the live process's
  environment for the new release, then `ops/prod/pull-release.sh fetch <sha>` (as root: the manifest must name exactly
  that commit, this box's arch and Node ABI; **refused unless at least 3 GiB stays free after the downloads, the unpacked
  build and the database backup** (`node_modules` is not counted when it will be hard-linked from the live release);
  both archives downloaded within one time budget; size, sha256 and `.build-commit` verified). It checks out the
  source as `ubuntu` in a new `/home/ubuntu/dazl-<sha8>-prod` and runs `pull-release.sh extract` there: the checkout's
  `package-lock.json` must be the one the build was made from; it unpacks `.next`, and hard-links `node_modules` from the
  live release when the lockfile is unchanged (else unpacks the built one). Then, as before: back up the database, `npm run
  db:migrate` as `ubuntu` (a script, no build), after a verified backup (online backup API, `integrity_check` ok, of
  the release's own `DB_PATH`; newest 10 kept in `/var/lib/dazl-prod-backups`), start `next start` as `ubuntu` on the
  spare port (3104/3105), wait for `/api/health` to report the commit,
  switch Caddy, and check `https://dazl.ai/api/health` (a mismatch switches straight back). Every health read is bounded
  (5 s to connect, 10 s in all): a listener that never answers counts as "no answer" and can never hang the deploy while it
  holds the lock. Release directories other than the live and the previous one are removed afterwards.
- **Rollback:** `deploy-prod.sh --rollback` points Caddy back at the previous release, which is still running on the
  other port, only if it still answers `/api/health` with the commit recorded for it (it refuses otherwise; a deploy that
  had to stop it clears the target). For an older commit, deploy it:
  its prebuilt build is downloaded again (or rebuilt on GitHub by hand), never built on the box.
- **Disk:** everything (the download cache, `/home/ubuntu`, `/var/lib`) is on `/`. Before its disk check the deploy removes
  each `/home/ubuntu/dazl-*-prod` that is not the live release, not the recorded rollback target and not the working
  directory of any listener (the previous release, a staging service), as that directory's owner (never as root; a
  root-owned one is left and logged). It then refuses with less than 3 GiB plus the backup free, and `pull-release.sh
  fetch` refuses (`ALERT low_disk`) when the downloads, the unpacked `.next`, the unpacked `node_modules` (only when it
  cannot be hard-linked: a changed lockfile) and the backup would leave less than 3 GiB; `extract` re-checks before it
  ever unpacks `node_modules`. Measured on 2026-11-13: 3,437,387,776 bytes free with three ~0.9 GB releases; a release
  needs about 229 MB of downloads + 180 MB of `.next` (+ 624 MB of `node_modules` with a new lockfile) + the 3 MB
  database. With the third, unused release removed (~0.9 GB back) the first prebuilt deploy fits: about 4.35 GB free
  before, about 3.94 GB after, against the 3.22 GB floor. An earlier commit's downloads still in the cache are counted as
  free (they are deleted before the new ones are fetched). Whatever does not fit is refused with `ALERT low_disk` and
  nothing changed; free space by hand (`docker system prune`, old logs) and deploy again.
- **Tests:** `python3 -m unittest discover -s ops/prod -p 'test_*.py'` runs both scripts end to end against stand-ins and
  fails if the deploy path ever runs `npm ci`, `npm install`, tsc or `next build`.

The steps below are the original manual procedure, kept for reference. Its build step (`npm ci && npm run build` on the box)
is replaced by the prebuilt release above and must not be run on the production box.

## Steps
1. On the box: `git fetch && git checkout <this PR's merge commit>` in a NEW directory (not the old app's), then unpack its prebuilt build (`ops/prod/pull-release.sh fetch <sha>` and `extract <sha> <dir>/web`); never `npm ci && npm run build` on the production box.
   Then `npm run db:migrate`. It does nothing while `DATABASE_URL` is unset (SQLite). Do not set `DATABASE_URL` in production until the owner authorizes the Postgres cutover (`docs/PLATFORM.md`, "Production go/no-go").
2. Put the env vars in a root-only env file and start the app on port 3100: `PORT=3100 npm start` under systemd or pm2 (one instance).
3. Check it before cutover: `curl localhost:3100/api/ready` (readiness: 200 with `ok:true`; a 503 names the failed check), then `curl -I localhost:3100/sign-up`. Probes for a process manager or load balancer: liveness `/api/health/live` (no store touched); `/api/health` adds whether each configured database (SQLite, Postgres when `DATABASE_URL` is set) answers, 503 if not (`node ops/health-smoke.mjs http://127.0.0.1:3100 <sha>` exits 0 only when it is ok with that commit); readiness `/api/ready` (same as `/api/health/ready`: store, schema, scan queue). Errors are JSON lines on stderr (`"level":"error"`) and each request is a JSON line on stdout (`"type":"request"`); both carry `request_id`, also returned to the client as the `x-request-id` response header. E.g. `journalctl -u <service> | grep '<request id>'`.
4. Back up Caddy: `cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-next`. Point dazl.ai `reverse_proxy` at `localhost:3100`. `caddy validate`, then `systemctl reload caddy`.
5. Smoke test on https://dazl.ai: sign up, Settings > add key, scan, leads page. Stripe test checkout.

## Previews (each PR, before production)
- Every pull request touching `web/` runs `.github/workflows/web-preview.yml`. It builds the PR exactly as production builds it and starts it with a throwaway SQLite database and one signed-in test account. Then it:
  - screenshots every page at desktop and mobile width (`npm run preview:shots`), into the run's `preview-pr<N>-<sha>` artifact (`index.html` plus PNGs; open the PR's checks > web-preview > Summary > Artifacts);
  - runs the production smoke checks against the same build (`test:smoke`, `test:smoke:chunks`).
- It uses no secrets and no production config: the server runs under the test network fence, so nothing is scanned, sent or billed. Pages show a new account's empty state.
- It is not a hosted URL. A clickable staging site needs a host, DNS and its own env file, which are owner decisions; the steps below are the plan, not something done.

## Staging site (plan; owner decision, not set up)
On the same box, beside production and sharing nothing with it:
1. Use a NEW directory and its own root-only env file, with `DB_PATH` set to a new file (never production's), `PUBLIC_BASE_URL=https://staging.dazl.ai`, a fresh `DAZL_MASTER_KEY`, Stripe **test** keys and a test-mode webhook secret for `https://staging.dazl.ai/api/stripe`, and `SENTRY_ENVIRONMENT=staging`.
2. Run it on another port (`PORT=3200 npm start`, one instance), checking `curl localhost:3200/api/ready` first.
3. Add a Caddy site for `staging.dazl.ai` with `basic_auth` in front of `reverse_proxy localhost:3200`, after backing up the Caddyfile as in step 4 above; `caddy validate`, then reload.
4. Deploy a PR's head there (`git checkout <sha>`, `npm ci && npm run build`, restart) to click through it before merge.

## Error monitoring on the deployed app
Server errors (uncaught route/page/action errors, process crashes, scan runner crashes) are already recorded as scrubbed JSON lines on stderr. They reach a person only once a destination is set in the production env file: `SENTRY_DSN` (Sentry or GlitchTip project DSN) and/or `OPS_ALERT_WEBHOOK_URL` (e.g. a Slack incoming webhook), then restart. Both are currently unset; setting them is an owner/Instinct production change. `/api/ready` does not require them.

## Release gate (before every production deploy)
`.github/workflows/release-gate.yml` runs on every PR touching `web/` or `ops/` and on every push to main. Deploy only a main commit whose release-gate run is green:
- **browser**: the production build, then in Chromium every /app page (`test:smoke`), chunk-load recovery (`test:smoke:chunks`), the sign-in gate on every page (`test:smoke:auth`), two tenants with no cross-tenant data on any session GET route or page (`test:smoke:tenants`), and release identity plus readiness (`test:smoke:release`).
- **migrations**: `scripts/migration-gate.mts` fills a database with the previous release's own staging seed plus a stored API key, migrates it with this release (every previous row kept by key with every value; a migration that must rewrite values lists the table and column in `EXPECTED_CHANGES`), migrates again (schema and values unchanged), runs the previous release's migration on it (no value changed), and has each release's own code verify the demo password and decrypt the key. `scripts/rollback-start-check.mjs` then starts the previous release's production build on that database: `/api/ready` ok, the demo account signs in, its scans and leads read back, `/app/leads` renders.
- Its `release-<sha>` artifact is `release.json` (`ops/release-manifest.mjs write`): commit, Next `BUILD_ID`, the sha256 of every static file, the lockfile's sha256, PG migrations.

After the cutover (step 3 and again after step 4), prove what is serving with the artifact's `release.json`:
`node ops/release-manifest.mjs check release.json http://127.0.0.1:3100` then `node ops/release-manifest.mjs check release.json https://dazl.ai`.
Exit 0 means: that exact commit, every static file served with exactly the bytes recorded (so the same commit and `BUILD_ID` with a changed chunk fails), and `/api/ready` ok. It prints one JSON line (commit, build id, static files matched, ready) to paste into the deploy report. A build made on the box is a different build (its own `BUILD_ID` and chunk bytes), so the CI manifest will not match it: run `node ops/release-manifest.mjs write web release.json` on the box after its build, compare that file's `commit` and `lockfile_sha256` with the CI artifact, and check against the box's own manifest. Byte identity with what CI tested holds only when the CI-built `.next` is what is deployed. Staging's `deploy.sh` logs the same line after each deploy (`journalctl -u dazl-staging-deploy`).

## Rollback
1. `cp /etc/caddy/Caddyfile.pre-next /etc/caddy/Caddyfile && systemctl reload caddy` (back on the old app in seconds).
2. Stop the new service. The old app and its database were never touched. The new DB file can stay or be deleted.

## Existing accounts and data
This app has its own users table (email, name, scrypt password hash). The old custom app has a different schema and also signs users in with Google, which has no password to move. There is no automatic migration: existing users would have to sign up again. If you want a one-off import of email and name for people with no data to keep, share a schema-only dump (no rows) of the old DB first.
