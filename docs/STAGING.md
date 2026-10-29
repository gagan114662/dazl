# staging.dazl.ai

Staging is the app on the same box as production, as a separate service. It has its own user, directory, port (3200), database and env file, and it is served by Caddy at `https://staging.dazl.ai`. It tracks `main`: a systemd timer checks every 2 minutes and deploys each new commit (`ops/staging/deploy.sh`).

**What is different in staging** (`DAZL_ENV=staging`, `web/lib/staging.ts`):
- A **"Staging - test data"** banner is on every page.
- Every page is **noindex**: the meta tag, the `X-Robots-Tag` header and `robots.txt` all say so.
- **Gmail is stubbed.**
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
- **Cutover.** From switching `current` until the new release passes the smoke check (`ops/health-smoke.mjs`: `/api/health` answers 200, `ok: true`, every configured database reachable, with the new commit), any failure goes to one handler: the switch itself, a non-zero restart command, or readiness. The handler:
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
| owned-inbox | an approved message reaches the owned staging inbox exactly once; a message edited after approval is refused (approval hash) |
| reply-stop | a reply in the thread stops the sequence, so step 2 is never sent. A control sequence with no reply does send step 2 at the same time. |
| opt-out | the unsubscribe link from the sent message suppresses the address for that tenant only; another tenant can still send to it |
| bounce | a mailer-daemon 5.x.x bounce suppresses the address, and the next message is not sent |
| uncertain | a send with an unknown outcome is marked uncertain and never retried, and blocks the tenant's other sends until resolved |
| restart | a process killed inside the provider call leaves the claim held. A fresh process reaps it as uncertain, makes no second provider call, and blocks the tenant. |

**Sending stays off.**
- The only transport is a recorder (`transport.log`). It returns fake ids and refuses any recipient outside a fixed allowlist of reserved `@staging.dazl.test` addresses.
- The script runs under the network fence, so any non-loopback connection throws. Gmail token and thread reads come from an in-process stub, and the master key is generated per run.
- It uses its own new SQLite file in `--out`. It refuses to run without `DAZL_ENV=staging`, onto a non-empty directory, or inside `DB_PATH`'s or `PROD_DB_PATH`'s directory. The staging and production databases are never opened.

Run it on the staging box after a deploy, as the service user, from the live release:

```bash
sudo install -d -o dazl-staging -m 750 /var/lib/dazl-staging-scenarios
cd /srv/dazl-staging/current/web && sudo -u dazl-staging env DAZL_ENV=staging DB_PATH=/var/lib/dazl-staging/app.db npm run -s staging:scenarios -- --out /var/lib/dazl-staging-scenarios/$(date -u +%Y%m%dT%H%M%SZ)
```

Exit codes: 0 means all passed, 1 means a scenario failed (named), 2 means it refused to run. To attach the evidence to #362, copy `evidence.json` to the issue. It records the commit, time, each check and the recorded recipients, and holds no secrets.

**Before any real send (not built; owner decisions):**
- A real owned-inbox send through a real provider needs a sending identity approved by the owner: a dedicated nonproduction Gmail account, and its own staging-only OAuth client with the send scope.
- It needs the exact recipient addresses, which must be inboxes the owner controls.
- It needs the exact approved words.
- It needs a separately reviewed change that adds a real transport behind an explicit staging flag and that allowlist.

Until then `deploy.sh` keeps refusing Google send credentials on staging, and the staging Gmail stub sends nothing.

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
