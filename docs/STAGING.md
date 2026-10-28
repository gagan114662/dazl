# staging.dazl.ai

Staging is the app on the same box as production, as a separate service. It has its own user, directory, port (3200), database and env file, and it is served by Caddy at `https://staging.dazl.ai`. It tracks `main`: a systemd timer checks every 2 minutes and deploys each new commit (`ops/staging/deploy.sh`).

**What is different in staging** (`DAZL_ENV=staging`, `web/lib/staging.ts`):
- A **"Staging - test data"** banner is on every page.
- Every page is **noindex**: the meta tag, the `X-Robots-Tag` header and `robots.txt` all say so.
- **Gmail is stubbed.**
  - Connect needs no Google account.
  - A send makes no network call and gets a stub id.
  - Reply sync reads nothing.
  - Google credentials are refused in the env file.
- **Stripe is test mode only:** a live key is refused.
- It has its **own database**, seeded with a demo account (`web/scripts/staging-seed.mts`):
  - a reviewed buyer profile;
  - two past scans with five leads (fictional companies on `.example.test`);
  - a sender identity;
  - the stub Gmail connection.
- **Error reports** are tagged `environment=staging`.

Nothing in staging uses production data or keys: a fresh master key, test-mode Stripe and no Google credentials.

## Before installing: disk and safety checks (`ops/staging/deploy.sh`)
- **Disk floor.** `MIN_FREE_BYTES` is 2 GiB by default, the host's floor. Every run of the 2-minute timer checks free space first:
  - **Below the floor:** the run is skipped (exit 0), before anything is fetched, built or deleted, and an alert is sent.
  - **A new release wouldn't fit above the floor** (free space minus its estimated size): skipped the same way, with an alert. The live release keeps serving.
  - **The floor is reached during a build:** a watcher stops the build, its release is deleted, an alert is sent, and the live release keeps serving.
  - **Alerts** are a JSON POST (`{"type":"staging_deploy","reason":"low_disk|low_disk_for_release|low_disk_during_build","free_bytes":…,"needed_bytes":…,"floor_bytes":…}`) to `OPS_ALERT_WEBHOOK_URL` in the staging env file. They're throttled to one per reason per hour while the disk stays low, and reset once a deploy finds enough room. Every skip is also logged to `journalctl -u dazl-staging-deploy`.
  - **Scope:** everything the deploy deletes is under `STAGING_ROOT`, and the deploy refuses a `STAGING_ROOT` that is inside, or contains, production's data directory. So production data and production's rollbacks are never touched.
  - **Sizes measured:** a first release is about 1.1 GB (`node_modules` 0.7 GB plus build output). Later releases hard-link `node_modules` from the live one when `package-lock.json` is unchanged, so they cost about their build output (0.3–0.4 GB).
  - **What's kept:** the live release plus two complete rollbacks.
  - **Space needed:** about **2.3 GB above the floor**, roughly 4.5 GB free on a 2 GiB floor. After the cleanup there's 5.42 GB free, enough for a first release; below that, the deploy skips and alerts instead of eating into the floor.
- **Production's database.** The deploy must be told where production's database is: `PROD_ENV_FILE` (production's env file, read for `DB_PATH` only) or `PROD_DB_PATH`, in `dazl-staging-deploy.service`. Without it, the deploy refuses to run. It refuses a staging `DB_PATH` that:
  - is production's file, by canonical path, with symlinks and `..` resolved;
  - is inside production's database directory, or contains it;
  - is the same file under another name (same device and inode).

  It also refuses any `DATABASE_URL`, since staging is its own SQLite file.
- **Cutover.** From switching `current` until the new release reports its commit on `/api/health`, any failure goes to one handler: the switch itself, a non-zero restart command, or readiness. The handler:
  - puts the previous complete release and its `release.env` back, restarts it, and checks it is really serving again before reporting `rolled back: <sha> is live again`;
  - reports `NO LIVE STAGING SERVICE` if that rollback restart or readiness fails, rather than claiming recovery;
  - on a failed first deployment, which has nothing to go back to, removes `current` and reports `NO LIVE STAGING SERVICE`.

  `test/staging-deploy.test.ts` injects each of these failures into the real `deploy.sh`.
- **Secrets.** The env file stays root-only (mode 600). The deploy runs as root, reads it, and passes its values to the build and seed, which run as `dazl-staging`. The service gets them from systemd's `EnvironmentFile`. The service user never reads the file.
- **End-to-end test** on a throwaway machine, as root: `bash ops/staging/e2e-test.sh`. It covers:
  - the floor refusal;
  - a first deploy as the service user with a root-only env file;
  - a no-op re-run;
  - a hard-linked second release;
  - a broken commit, which is removed while the live release keeps serving;
  - the floor being reached mid-build.

## One-time setup (Instinct, on the box, as root)

1. **DNS.** Add an `A` record `staging.dazl.ai` pointing to the box's public IPv4 address, the same as `dazl.ai`. Add an `AAAA` record too if `dazl.ai` has one. Check with `dig +short staging.dazl.ai`.
2. **User and directories:**
   ```sh
   useradd --system --create-home --home-dir /srv/dazl-staging --shell /usr/sbin/nologin dazl-staging
   install -d -o dazl-staging -g dazl-staging -m 750 /srv/dazl-staging/releases /var/lib/dazl-staging
   install -d -m 700 /etc/dazl-staging
   ```
3. **Env file.** Copy `ops/staging/env.example` to `/etc/dazl-staging/env`, then `chmod 600` it.
   - `DAZL_MASTER_KEY`: a new key from `openssl rand -base64 32`, never production's.
   - Stripe, in the Stripe dashboard switched to **Test mode**:
     - `STRIPE_SECRET_KEY` is the `sk_test_` key;
     - `STRIPE_PRICE_PRO` is the test-mode Pro price;
     - `STRIPE_WEBHOOK_SECRET` is the signing secret of a test-mode webhook endpoint `https://staging.dazl.ai/api/stripe`, with events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.payment_failed`.
   - `STAGING_DEMO_PASSWORD`: generate it on the host (`openssl rand -base64 18`) and give it to Gagan privately. It's never in the repo or a PR.
   - `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`: from Hermes, or leave empty until they arrive.
   - Then check it. This exits 0 with `env ok` only if it's a staging file; it never prints a value:
     ```sh
     PROD_ENV_FILE=<production's env file> bash ops/staging/deploy.sh --check-env /etc/dazl-staging/env
     ```
4. **Units and the deploy script.** From a checkout of `main`:
   ```sh
   install -m 755 ops/staging/deploy.sh /srv/dazl-staging/deploy.sh
   install -m 644 ops/staging/dazl-staging.service ops/staging/dazl-staging-deploy.service ops/staging/dazl-staging-deploy.timer /etc/systemd/system/
   # set PROD_ENV_FILE in dazl-staging-deploy.service to production's real env file
   systemctl edit --full dazl-staging-deploy.service
   systemctl daemon-reload
   ```
5. **First deploy.** It clones, builds, seeds, starts and health-checks; expect a few minutes:
   ```sh
   systemctl enable dazl-staging.service
   systemctl start dazl-staging-deploy.service; journalctl -u dazl-staging-deploy -n 50 --no-pager   # ends with "live: <sha>"
   curl -s localhost:3200/api/health    # {"ok":true,"commit":"<sha of main>"}
   curl -s localhost:3200/api/ready     # 200 once the Stripe test values are set
   ```
6. **Caddy.**
   ```sh
   cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-staging
   cat ops/staging/Caddyfile.staging >> /etc/caddy/Caddyfile
   caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
   ```
   Caddy gets the TLS certificate once DNS resolves.
7. **Track main:**
   ```sh
   systemctl enable --now dazl-staging-deploy.timer
   systemctl list-timers dazl-staging-deploy.timer
   ```

## Verify (the done check)
- `https://staging.dazl.ai` loads with the yellow **Staging - test data** banner.
- `curl -sI https://staging.dazl.ai | grep -i x-robots-tag` shows `noindex, nofollow`.
- `curl -s https://staging.dazl.ai/robots.txt` shows `Disallow: /`.
- Sign in as `demo@staging.dazl.test` with the password generated in step 3. Leads > Past scans > *Dental practices in Texas hiring a practice manager* shows the demo leads. Settings shows Gmail connected as `sender-…@staging.dazl.test`.
- `curl -s https://staging.dazl.ai/api/health` reports the commit at the head of `main`. After the next merge it changes within about 2 minutes plus build time.
- Locally, the same checks run in Chromium: `DAZL_ENV=staging npm run build && npm run test:smoke:staging` (in `web/`).

## Day to day
- **Deploys** are automatic. `journalctl -u dazl-staging-deploy` shows each one. A build or health-check failure keeps the previous release serving, and the journal ends with `rolling back`.
- **Pause tracking:** `systemctl stop dazl-staging-deploy.timer`.
- **Reset the data:**
  ```sh
  systemctl stop dazl-staging
  rm /var/lib/dazl-staging/app.db*
  systemctl start dazl-staging-deploy.service
  ```
  The seed runs on every deploy and recreates the demo account. To force one now, `rm /srv/dazl-staging/current-sha` first.
- **Load on the box:** each deploy runs a build at `nice 10` with a 2 GB heap cap, and the service is capped at 1.5 GB. `npm ci` runs only when the lockfile changed. If production feels it, lengthen the timer (`OnUnitActiveSec`) or build elsewhere.
- **Remove staging:**
  ```sh
  systemctl disable --now dazl-staging-deploy.timer dazl-staging
  ```
  Then restore `/etc/caddy/Caddyfile.pre-staging` and reload Caddy, and delete `/srv/dazl-staging`, `/var/lib/dazl-staging`, `/etc/dazl-staging` and the DNS record.

## Limits
- It's one box. A staging build competes with production for CPU while it runs; production's own service and port are never touched.
- Staging has no TinyFish or other operator provider keys. Drafting emails and new scans need an AI key, which the tester adds in Settings, the same as production.
- Signing up is open on staging, like production. Accounts there hold test data only.
