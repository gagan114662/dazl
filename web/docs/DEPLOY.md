# Deploying the Next.js app (web/) on the EC2 box

Run it as ONE Node process (in-memory rate limits and the in-process scan runner assume that).

## Env vars
Required:
- `DB_PATH` - SQLite file. Use a NEW path (for example /var/lib/dazl-next/app.db). Never point it at the old app's database.
- `DAZL_MASTER_KEY` - base64 of exactly 32 random bytes (`openssl rand -base64 32`). Encrypts customer API keys. Losing it makes stored keys unreadable. Do not rotate casually.
- `PUBLIC_BASE_URL` - https://dazl.ai
- `STRIPE_SECRET_KEY` - sk_test_ until you go live, then sk_live_
- `STRIPE_PRICE_PRO` - the Pro price ID (copy it from the Stripe dashboard)
- `STRIPE_WEBHOOK_SECRET` - whsec_ for https://dazl.ai/api/billing/webhook
Optional: `OPS_ALERT_WEBHOOK_URL` (https; receives each scrubbed error record, throttled; see `lib/ops/errors.ts`), `SENTRY_DSN` (https; the same records as Sentry events, throttled; `SENTRY_ENVIRONMENT` optional), `DAZL_SCAN_SHARED_QUEUE` (`1` claims scans through the shared work queue, `lib/queue/scan-claimer.ts`; default off, see docs/PLATFORM.md), `SCAN_MAX_CONCURRENT` (3), `SCAN_RENDER_URL` and `SCAN_RENDER_TOKEN` (separate renderer container only), `DAZL_ANTHROPIC_MODEL`, `DAZL_OPENAI_MODEL`, `SCAN_STALE_RUNNING_S`, `SCAN_PAGE_TIMEOUT_MS`, `SCAN_LLM_TIMEOUT_MS`, `SCAN_MAX_AGE_DAYS`.
Not used in this release: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (Gmail is PR #13, separate).

## Steps
1. On the box: `git fetch && git checkout <this PR's merge commit>` in a NEW directory (not the old app's), then `cd web && npm ci && npm run build`.
   Then `npm run db:migrate`. It does nothing while `DATABASE_URL` is unset (SQLite). Do not set `DATABASE_URL` in production until the owner authorizes the Postgres cutover (`docs/PLATFORM.md`, "Production go/no-go").
2. Put the env vars in a root-only env file and start the app on port 3100: `PORT=3100 npm start` under systemd or pm2 (one instance).
3. Check it before cutover: `curl localhost:3100/api/health` (readiness: 200 with `ok:true`; a 503 names the failed check), then `curl -I localhost:3100/sign-up`. Probes for a process manager or load balancer: liveness `/api/health/live`, readiness `/api/ready` (same as `/api/health/ready`). Errors are JSON lines on stderr (`"level":"error"`) and each request is a JSON line on stdout (`"type":"request"`); both carry `request_id`, also returned to the client as the `x-request-id` response header. E.g. `journalctl -u <service> | grep '<request id>'`.
4. Back up Caddy: `cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-next`. Point dazl.ai `reverse_proxy` at `localhost:3100`. `caddy validate`, then `systemctl reload caddy`.
5. Smoke test on https://dazl.ai: sign up, Settings > add key, scan, leads page. Stripe test checkout.

## Rollback
1. `cp /etc/caddy/Caddyfile.pre-next /etc/caddy/Caddyfile && systemctl reload caddy` (back on the old app in seconds).
2. Stop the new service. The old app and its database were never touched. The new DB file can stay or be deleted.

## Existing accounts and data
This app has its own users table (email, name, scrypt password hash). The old custom app has a different schema and also signs users in with Google, which has no password to move. There is no automatic migration: existing users would have to sign up again. If you want a one-off import of email and name for people with no data to keep, share a schema-only dump (no rows) of the old DB first.
