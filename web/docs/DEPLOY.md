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
Optional: `OPS_ALERT_WEBHOOK_URL` (https; receives each scrubbed error record, throttled; see `lib/ops/errors.ts`), `SENTRY_DSN` (https; the same records as Sentry events, throttled; `SENTRY_ENVIRONMENT` optional), `DAZL_SCAN_SHARED_QUEUE` (`1` claims scans through the shared work queue, `lib/queue/scan-claimer.ts`; default off, see docs/PLATFORM.md), `SCAN_MAX_CONCURRENT` (3), `SCAN_RENDER_URL` and `SCAN_RENDER_TOKEN` (separate renderer container only), `DAZL_ANTHROPIC_MODEL`, `DAZL_OPENAI_MODEL`, `SCAN_STALE_RUNNING_S`, `SCAN_PAGE_TIMEOUT_MS`, `SCAN_LLM_TIMEOUT_MS`, `SCAN_MAX_AGE_DAYS`.
Not used in this release: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (Gmail is PR #13, separate).

## Steps
1. On the box: `git fetch && git checkout <this PR's merge commit>` in a NEW directory (not the old app's), then `cd web && npm ci && npm run build`.
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
- **migrations**: `scripts/migration-gate.mts` fills a database with the previous release's own staging seed, migrates it with this release (no row lost), migrates again (nothing changes), then starts the previous release on it (rollback still works).
- Its `release-<sha>` artifact is `release.json` (`ops/release-manifest.mjs write`): commit, Next `BUILD_ID`, sha256 of the static tree and lockfile, PG migrations.

After the cutover (step 3 and again after step 4), prove what is serving with the artifact's `release.json`:
`node ops/release-manifest.mjs check release.json http://127.0.0.1:3100` then `node ops/release-manifest.mjs check release.json https://dazl.ai`.
Exit 0 means: that exact commit, that exact build (its `/_next/static/<BUILD_ID>/` answers), and `/api/ready` ok. It prints one JSON line (commit, build id, ready) to paste into the deploy report. Building on the box gives a new `BUILD_ID`; then run `ops/release-manifest.mjs write web release.json` there and compare its `commit` and `lockfile_sha256` with the CI artifact before checking. Staging's `deploy.sh` logs the same line after each deploy (`journalctl -u dazl-staging-deploy`).

## Rollback
1. `cp /etc/caddy/Caddyfile.pre-next /etc/caddy/Caddyfile && systemctl reload caddy` (back on the old app in seconds).
2. Stop the new service. The old app and its database were never touched. The new DB file can stay or be deleted.

## Existing accounts and data
This app has its own users table (email, name, scrypt password hash). The old custom app has a different schema and also signs users in with Google, which has no password to move. There is no automatic migration: existing users would have to sign up again. If you want a one-off import of email and name for people with no data to keep, share a schema-only dump (no rows) of the old DB first.
