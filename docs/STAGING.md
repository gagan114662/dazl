# staging.dazl.ai

Staging is the app on the same box as production, as a separate service. It has its own user, directory, port (3200), database and env file, and it is served by Caddy at `https://staging.dazl.ai`. It tracks `main`: a systemd timer checks every 2 minutes and deploys each new commit (`ops/staging/deploy.sh`).

**What is different in staging** (`DAZL_ENV=staging`, `web/lib/staging.ts`):
- A **"Staging - test data"** banner is on every page.
- Every page is **noindex**: the meta tag, the `X-Robots-Tag` header and `robots.txt` all say so.
- **Gmail is stubbed by default** (real staging Gmail exists behind an explicit flag, off; see "Real staging Gmail" below).
  - Connect needs no Google account.
  - A send makes no network call and gets a stub id.
  - Reply sync reads nothing.
  - Gmail's Google credentials (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) are refused in the env file.
- **Sign in with Google** works only with a dedicated, identity-only staging OAuth client (see below); without one the
  button reports "not available".
- **Stripe is test mode only:** a live key is refused.
- It has its **own database**, seeded with a demo account (`web/scripts/staging-seed.mts`):
  - a reviewed buyer profile;
  - two past scans with five leads (fictional companies on `.example.test`);
  - a sender identity;
  - the stub Gmail connection.
- **Error reports** are tagged `environment=staging`.

Nothing in staging uses production data or keys: a fresh master key, test-mode Stripe, no Gmail credentials, and at most a dedicated staging sign-in client.

## Before installing: disk and safety checks (`ops/staging/deploy.sh`)
- **Disk floor.** `MIN_FREE_BYTES` is 2 GiB by default, the host's floor. Every run of the 2-minute timer checks free space first:
  - **Below the floor:** the run is skipped (exit 0), before anything is fetched, built or deleted, and an alert is sent.
  - **A new release wouldn't fit above the floor** (free space minus its estimated size): skipped the same way, with an alert. The live release keeps serving.
  - **A reserve above the floor** (`DISK_RESERVE_BYTES`, 256 MiB by default) is kept while building, so the floor itself is never crossed:
    - a release is started only if free space minus its estimate stays above the floor plus the reserve;
    - a watcher checks every 0.5 s and stops the build once free space falls into the reserve. Its release is deleted, an alert is sent, and the live release keeps serving.
  - **After the build and seed exit, immediately before cutover,** free space is checked once more. A build can finish, and write most of its output, after the watcher's last look. If free space is below the floor plus the reserve, the release is not put live: it's deleted, an alert (`low_disk_after_build`) is sent, and the live release keeps serving.
  - **Alerts** are a JSON POST (`{"type":"staging_deploy","reason":"low_disk|low_disk_for_release|low_disk_during_build|low_disk_after_build","free_bytes":…,"needed_bytes":…,"floor_bytes":…}`) to `OPS_ALERT_WEBHOOK_URL` in the staging env file. They're throttled to one per reason per hour while the disk stays low, and reset once a deploy finds enough room. Every skip is also logged to `journalctl -u dazl-staging-deploy`.
  - **Scope:** everything the deploy deletes is under `STAGING_ROOT`, and the deploy refuses a `STAGING_ROOT` that is inside, or contains, production's data directory. So production data and production's rollbacks are never touched.
  - **Sizes measured:** a first release is about 1.1 GB (`node_modules` 0.7 GB plus build output). Later releases hard-link `node_modules` from the live one when `package-lock.json` is unchanged, so they cost about their build output (0.3–0.4 GB).
  - **What's kept:** the live release plus two complete rollbacks.
  - **Space needed:** about **2.3 GB above the floor**, roughly 4.5 GB free on a 2 GiB floor. After the cleanup there's 5.42 GB free, enough for a first release; below that, the deploy skips and alerts instead of eating into the floor.
- **Production's database.** The deploy must be told where production's database is: `PROD_ENV_FILE` (production's env file, read for `DB_PATH` only) or `PROD_DB_PATH`, in `dazl-staging-deploy.service`. Without it, the deploy refuses to run. It refuses a staging `DB_PATH` that:
  - is production's file, by canonical path, with symlinks and `..` resolved;
  - is inside production's database directory, or contains it;
  - is the same file under another name (same device and inode).

  It also refuses any `DATABASE_URL`, since staging is its own SQLite file.
- **Root never writes by a name the service account controls (#972).** `/srv/dazl-staging` is the service account's home, so any file there can be swapped for a symlink. The deploy's own state (the lock, `current-sha`, `release.env`, alert stamps) lives in `STAGING_STATE_ROOT` (default `/var/lib/dazl-staging-deploy`): root-owned, mode 700, checked like the recovery root before anything runs. systemd reads `release.env` from there as root. In the home, root only replaces the `current` symlink (a symlink is never written through), creates each release's `.complete` exclusively without following a symlink, refuses a symlinked `STAGING_ROOT` or `releases` directory, skips and removes symlinks it finds inside `releases`, and takes the live release from `current` only when it names a real directory directly under `releases`. **Releases outside the home (#908 rename race).** Releases live in `STAGING_RELEASES` (default `/srv/dazl-staging-releases`, beside the home, never inside it): owned by root, group `dazl-staging`, mode 750, so the service can read and run them but cannot rename, replace or plant anything in that directory. Before anything is stopped the deploy refuses a releases directory that is a symlink, inside (or containing) the home or production's data directory, writable by anyone but root, or under a parent another user can change (a root-owned sticky directory like `/tmp` is allowed); it also refuses a `current` that is not a symlink, or that still points into the old in-home `releases` (see upgrading below). Root only creates and deletes whole releases there; reading, sizing, hard-linking and running a release's own files (`du`, `cp -al` of `node_modules`, `health-smoke.mjs`, `release-manifest.mjs`) runs as the service account, so a symlink it plants inside a release reaches nothing it couldn't read itself. In the home, root only replaces the `current` symlink.
- **Recovery point before any schema change (#908).** The build no longer migrates. After the build and disk checks, the deploy stops the service (`STAGING_STOP`, default `systemctl stop`), so nothing writes, then `ops/staging/recovery_point.py create` takes a copy of `DB_PATH` with SQLite's online backup API, checks integrity, and writes a manifest binding the copy's sha256 to the database's canonical path and the live release's commit. It re-reads the copy before going on. Only then does `STAGING_MIGRATE` (migrate + seed) run. Fail closed: if the service can't be stopped or the copy can't be verified, nothing is migrated, the release is removed and the old release is restarted unchanged. A failed migration or partial seed restores the copy and restarts the old release. Recovery points live in `STAGING_RECOVERY_ROOT` (default `/var/lib/dazl-staging-recovery`): root-owned, mode 700, outside `STAGING_ROOT`, on a path no other user can write (the helper refuses otherwise, before anything is stopped), so the service account cannot rename, replace or remove one. Each attempt gets a new directory (`<sha>.<time>.<pid>`); its copy and manifest are created exclusively, read-only (0400) and fsynced, as are their directories. The newest three are kept. **Pending marker:** from just before the migration until the new release is healthy, `STAGING_RECOVERY_ROOT/pending` names the recovery point, its manifest sha256 and the previous release. If the deploy is killed, or a restore fails, the next run finishes that restore first (refusing a recovery point whose manifest is not the recorded one), puts the previous release back and only then deploys again; it never backs up the migrated database as a new recovery point while one is pending. The deploy commits when the marker is removed. Downtime: the service is down from the stop until the new release is healthy. The migration runs in its own process group without the deploy lock; anything it leaves running in that group is stopped (TERM, then KILL) before the deploy goes on or restores. A process that escapes the group is not reached by this step alone; #907's build containment (`contain.py`) is meant to wrap the migration the same way once both land. A restore removes stale `-wal`/`-shm`/`-journal` files beside the database so none can replay over the restored copy. The database directory belongs to the service account, so the restore works through a directory descriptor and never follows a symlink: the new file is created exclusively under an unpredictable name, its owner and mode set through its descriptor, renamed over `DB_PATH`, and checked to be that same file. It is durable and restartable: the sidecars are moved aside (not deleted), the copy is installed and fsynced, and only then are the moved files removed; re-running an interrupted restore finishes it.
- **Build containment (#907).** The build runs under `ops/staging/contain.py`, a child subreaper: a build process that leaves the build's session or process group (setsid) and outlives its parent is still re-parented to it. When the build ends, fails, hits the disk floor, or the deploy is aborted (TERM/INT/HUP), every remaining build process gets TERM, `STAGING_BUILD_GRACE` seconds (10), then KILL, and the deploy waits for confirmed exit before deleting the release. Only the build's own descendants are signalled, never a process by name or port. If one survives KILL, the deploy reports `cleanup BLOCKED` and leaves the release in place for an operator. The build does not inherit the deploy lock. **Scope:** containment covers the build only. The migration and seed run afterwards (#908), in their own process group with their own shutdown before any restore, and are not contained by this wrapper; the build itself stays migration-free.
- **Cutover.** From switching `current` until the new release passes the smoke check (`ops/health-smoke.mjs`: `/api/health` answers 200, `ok: true`, every configured database reachable, with the new commit), any failure goes to one handler: the switch itself, a non-zero restart command, or readiness. The handler:
  - stops the failed release and restores the pre-migration database from the recovery point (verified by hash) BEFORE any old code starts; if that restore fails it reports `NO LIVE STAGING SERVICE` and does not start old code against a migrated database. Writes the failed release made before rollback are discarded with it;
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
   install -d -o dazl-staging -g dazl-staging -m 750 /var/lib/dazl-staging
   install -d -o root -g dazl-staging -m 750 /srv/dazl-staging-releases
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
   install -d -o root -g root -m 755 /usr/local/lib/dazl-staging
   install -o root -g root -m 755 ops/staging/deploy.sh ops/staging/recovery_point.py /usr/local/lib/dazl-staging/
   install -d -o root -g root -m 700 /var/lib/dazl-staging-recovery /var/lib/dazl-staging-deploy
   install -m 644 ops/staging/dazl-staging.service ops/staging/dazl-staging-deploy.service ops/staging/dazl-staging-deploy.timer /etc/systemd/system/
   # set PROD_ENV_FILE in dazl-staging-deploy.service to production's real env file
   systemctl edit --full dazl-staging-deploy.service
   systemctl daemon-reload
   ```
   Upgrading a box set up before #908: run the three `install` lines, reinstall `dazl-staging-deploy.service` (its `ExecStart` is now `/usr/local/lib/dazl-staging/deploy.sh`) keeping your `PROD_ENV_FILE`, `systemctl daemon-reload`, then `rm /srv/dazl-staging/deploy.sh`. Reinstall `dazl-staging.service` too (its `EnvironmentFile` is now `/var/lib/dazl-staging-deploy/release.env`) and then remove the old `/srv/dazl-staging/release.env`, `/srv/dazl-staging/current-sha`, `/srv/dazl-staging/.deploy.lock` and `/srv/dazl-staging/.alert-*`; the first run after the upgrade takes the deployed commit from the live complete release, so nothing is redeployed. `deploy.sh` refuses to stop anything when `recovery_point.py` is missing beside it, or it or its directory is writable by anyone but root.

   Upgrading a box whose releases are still in `/srv/dazl-staging/releases` (#908 rename race): the deploy refuses to run, stopping nothing, while `current` points there. With the deploy timer stopped (`systemctl stop dazl-staging-deploy.timer`), as root:
   ```sh
   find /srv/dazl-staging/releases -mindepth 1 -maxdepth 1 ! -type d -print   # anything listed is not a release: inspect, then delete it
   install -d -o root -g dazl-staging -m 750 /srv/dazl-staging-releases
   mv /srv/dazl-staging/releases/* /srv/dazl-staging-releases/
   ln -sfn "/srv/dazl-staging-releases/$(basename "$(readlink /srv/dazl-staging/current)")" /srv/dazl-staging/current
   rmdir /srv/dazl-staging/releases
   systemctl restart dazl-staging.service && systemctl start dazl-staging-deploy.timer
   ```
   The release directories keep their owner (the service account); only the directory holding them changes hands. The restart just re-reads `current` through its new path, same release.
5. **First deploy.** It clones, builds, seeds, starts and health-checks; expect a few minutes:
   ```sh
   systemctl enable dazl-staging.service
   systemctl start dazl-staging-deploy.service; journalctl -u dazl-staging-deploy -n 50 --no-pager   # ends with "live: <sha>"
   curl -s localhost:3200/api/health    # {"ok":true,"commit":"<sha of main>",...,"checks":{"sqlite":{"ok":true,...},...}}
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

## Sign in with Google (runbook, Instinct)
Staging can sign people in with Google through its **own** OAuth client, used for identity only. Gmail stays stubbed:
the Gmail client is never configured on staging, and the app refuses sign-in on staging while it is.
1. In Google Cloud, create a new OAuth client (Web application) for staging only. Its consent screen asks only for
   `openid`, `email` and `profile`. Its single authorized redirect URI is
   `https://staging.dazl.ai/api/auth/callback/google`. Do not reuse production's client.
2. In `/etc/dazl-staging/env` set `GOOGLE_SIGNIN_CLIENT_ID` (`….apps.googleusercontent.com`) and
   `GOOGLE_SIGNIN_CLIENT_SECRET`. Leave `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` unset.
3. `PROD_ENV_FILE=<production's env file> bash ops/staging/deploy.sh --check-env /etc/dazl-staging/env` prints
   `env ok`. With a sign-in client set, the check needs production's env file, and refuses an id or secret equal to any
   Google client there. Values are never printed.
4. `systemctl restart dazl-staging.service` (no rebuild needed: the sign-in routes read their configuration on each
   request and are never cached). Then `curl -sI https://staging.dazl.ai/api/auth/google` shows a 307 to
   `accounts.google.com` with this client's id, `redirect_uri=https://staging.dazl.ai/api/auth/callback/google`,
   `scope=openid email profile` and `cache-control: no-store`.

## Free trial without Google sign-in (test accounts only, #1037)

The free trial needs a Google sign-in (product truth `google_account`). To live-check a brand-new **password** account's first play
on staging, list its exact address in `DAZL_STAGING_TRIAL_NO_GOOGLE` (comma-separated, no wildcards) in the staging env file. Only the
Google prerequisite is skipped for those addresses; every other trial limit still applies. The setting is read only when
`DAZL_ENV=staging`. It keys on the signup email, which a password signup does not verify, so list only throwaway test addresses
(whoever registers a listed address first gets the exemption) and remove them after the check.

## Stripe in test mode (runbook, Instinct)
Staging takes test-mode Stripe only: `deploy.sh --check-env` refuses any `sk_live_` or `rk_live_` key, and staging never holds a live key. Set these four values in `/etc/dazl-staging/env`, all from the Stripe dashboard with **Test mode** switched on:

| Variable | Value | Where it comes from |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…`, or a restricted `rk_test_…` key | Developers → API keys. A restricted key needs: Checkout Sessions **write**, Customer portal **write**, Subscriptions **read**. These are the only three calls the app makes: `POST /v1/checkout/sessions`, `POST /v1/billing_portal/sessions`, `GET /v1/subscriptions/:id`. |
| `STRIPE_PRICE_PRO` | `price_…` | Product catalog → the Pro product → its recurring price, created in test mode. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | Developers → Webhooks → Add endpoint `https://staging.dazl.ai/api/stripe`, with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.payment_failed`. Then reveal its signing secret. |
| `PUBLIC_BASE_URL` | `https://staging.dazl.ai` | Already set. Checkout returns to `…/app/settings?billing=success` (or `=cancelled`), and the portal returns to `…/app/settings`. |

In Settings → Billing → Customer portal (test mode), save the portal configuration once, or portal sessions fail.

Then check, in this order:
1. `PROD_ENV_FILE=<production's env file> bash ops/staging/deploy.sh --check-env /etc/dazl-staging/env` prints `env ok`.
2. `systemctl restart dazl-staging.service`. Then `curl -s localhost:3200/api/ready` shows `"env":{"ok":true,"missing":0}`; a malformed value counts as missing, by count only.
3. In a browser on `https://staging.dazl.ai`:
   - Sign in, open Settings → **Upgrade to Pro**, and pay with Stripe's test card `4242 4242 4242 4242` (any future date, any CVC). Stripe test mode moves no money.
   - Back on Settings the plan reads **Pro**, and `/api/usage` shows `"plan":"pro","scan_limit":null`. In Stripe → Webhooks → the endpoint, the delivery shows **200** with `{"result":"applied"}`.
4. Settings → **Manage billing** opens the portal; cancel there (at period end): still Pro. Then cancel the subscription immediately from the Stripe dashboard: the plan reads **Free** with `billing_status` `canceled`, and the Free monthly scan limit applies again.

The same chain is pinned in CI without Stripe by `web/test/stripe-flow.test.ts`, on SQLite and Postgres. That chain is checkout → signed webhook → plan → the scan limit → cancel at period end → deleted → Free and limited again.

## Verify (the done check)
- `https://staging.dazl.ai` loads with the yellow **Staging - test data** banner.
- `curl -sI https://staging.dazl.ai | grep -i x-robots-tag` shows `noindex, nofollow`.
- `curl -s https://staging.dazl.ai/robots.txt` shows `Disallow: /`.
- Sign in as `demo@staging.dazl.test` with the password generated in step 3. Leads > Past scans > *Dental practices in Texas hiring a practice manager* shows the demo leads. Settings shows Gmail connected as `sender-…@staging.dazl.test`.
- `curl -s https://staging.dazl.ai/api/health` reports the commit at the head of `main`. After the next merge it changes within about 2 minutes plus build time.
- Locally, the same checks run in Chromium: `DAZL_ENV=staging npm run build && npm run test:smoke:staging` (in `web/`).

## Send-safety scenarios (runbook, Instinct; issue #362)
`web/scripts/staging-send-scenarios.mts` drives the app's real send, sequence, reply-sync, unsubscribe and uncertain-send code through six scenarios and writes `evidence.json`:

| scenario | proves |
|---|---|
| owned-inbox-handoff | an approved message addressed to the owned staging inbox is handed to the provider interface exactly once. The recorded MIME has the approved subject; the body before the footer is exactly the approved words; the footer has the sender's name, postal address and an unsubscribe link equal to `List-Unsubscribe` that resolves to this message. A message edited after approval is refused (approval hash). |
| reply-stop | a reply in the thread stops the sequence, so step 2 is never sent. A control sequence with no reply does send step 2 at the same time. |
| opt-out | the unsubscribe link from the sent message suppresses the address for that tenant only; another tenant can still send to it |
| bounce | a mailer-daemon 5.x.x bounce suppresses the address, and the next message is not sent |
| uncertain | a send with an unknown outcome is marked uncertain and never retried, and blocks the tenant's other sends until resolved |
| restart | a process killed inside the provider call leaves the claim held. A fresh process reaps it as uncertain, makes no second provider call, and blocks the tenant. |

**Sending stays off.** Every scenario stops at a **recorded hand-off** to the provider interface. Nothing is delivered to any inbox, and the evidence is not proof of delivery.
- The only transport is a recorder (`transport.log`). It returns fake ids and refuses any recipient outside a fixed allowlist of reserved `@staging.dazl.test` addresses.
- The script runs under the network fence, so any non-loopback connection throws. Gmail token and thread reads come from an in-process stub, and the master key is generated per run.
- It uses its own new SQLite file in `--out`. It refuses to run without `DAZL_ENV=staging`, onto a non-empty directory, or inside `DB_PATH`'s or `PROD_DB_PATH`'s directory. The staging and production databases are never opened.

Run it on the staging box after a deploy, as the service user, from the live release:

```bash
sudo install -d -o dazl-staging -m 750 /var/lib/dazl-staging-scenarios
cd /srv/dazl-staging/current/web && sudo -u dazl-staging env DAZL_ENV=staging DB_PATH=/var/lib/dazl-staging/app.db npm run -s staging:scenarios -- --out /var/lib/dazl-staging-scenarios/$(date -u +%Y%m%dT%H%M%SZ)
```

Exit codes: 0 means all passed, 1 means a scenario failed (named), 2 means it refused to run. To attach the evidence to #362, copy `evidence.json` to the issue. It records the commit, time, each check and the recorded recipients, and holds no secrets.

**Real staging Gmail (#413): built, OFF by default, not activated.** The code is merged-ready capability only; sending anything for real still needs the owner's approval of the sending identity, the exact recipient addresses and the exact words at execution time.
- It is on only when `DAZL_ENV=staging` and `DAZL_STAGING_REAL_GMAIL=1`. Unset or any other value: the stub above, unchanged. In production the flag is ignored.
- Its own staging-only Google OAuth client: `GMAIL_STAGING_CLIENT_ID` / `GMAIL_STAGING_CLIENT_SECRET`, `gmail.send` scope (plus optional `gmail.readonly` as the connect route already records), redirect `https://staging.dazl.ai/api/gmail/callback`. Never `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` on staging: those switch off staging sign-in, and `deploy.sh` still refuses them.
- `DAZL_STAGING_GMAIL_ALLOWLIST`: exact owner-controlled addresses, comma separated, no wildcards or domains. The send path checks every To, Cc and Bcc address before any provider request and refuses anything else.
- Token exchange, send and reply reading switch together. With the flag on but any setting missing or malformed, every Gmail call refuses (`staging_gmail_misconfigured`); nothing falls back to a real send.
- `deploy.sh` refuses Gmail credentials or an allowlist without the flag, the flag without both credentials and a valid allowlist, and any client id or secret that matches production's or the sign-in client's.

## Day to day
- **Deploys** are automatic. `journalctl -u dazl-staging-deploy` shows each one. A build or health-check failure keeps the previous release serving, and the journal ends with `rolling back`.
- **Pause tracking:** `systemctl stop dazl-staging-deploy.timer`.
- **Reset the data:**
  ```sh
  systemctl stop dazl-staging
  rm /var/lib/dazl-staging/app.db*
  systemctl start dazl-staging-deploy.service
  ```
  The seed runs on every deploy and recreates the demo account. To force one now, `rm /var/lib/dazl-staging-deploy/current-sha` first.
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
