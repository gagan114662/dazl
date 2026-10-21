# dazl advanced-connectors worker

Runs the session-cookie platforms (X and Reddit today) for dazl scans. The dazl app
calls this worker over HTTP with one tenant's own session cookie per request; the
worker holds no database, no tenant id and no keys of its own.

## Account-ban and platform-terms risk (read before enabling)

- **X: HIGH risk.** X's terms and robots.txt disallow automated access. The worker
  searches X through the same GraphQL endpoint the web app uses, with the tenant's
  session cookie. Realistic outcome if used regularly: the account gets rate-limited,
  flagged, or suspended. X also rotates the GraphQL query id and feature flags, so
  this fetcher will break from time to time (see `X_QUERY_ID` below).
- **Reddit: MEDIUM risk.** Reddit's terms limit automated access. The public
  `search.json` endpoint with a logged-in cookie is the gentlest path, but accounts
  can still be rate-limited or suspended for automated use.
- Both: the product already requires the tenant to accept a risk notice and use a
  throwaway account, never their main one. The app also caps calls per tenant per
  hour (`ADVANCED_MAX_PER_HOUR`, default 10). Do not raise that cap carelessly.

## Protocol

`POST /fetch` with `Authorization: Bearer $ADVANCED_WORKER_TOKEN` and body
`{platform, query, session}` returns `{items:[{url,title,quote,date,login_walled}]}`
(max 20 items). `GET /health` returns `{ok:true, platforms:["reddit","x"]}`.
Platforms with no fetcher yet return `{items:[]}` (audited as `empty`, not an error).

## Deploy on EC2 (Docker, ~5 minutes)

```bash
# 1. on the EC2 host
sudo dnf install -y docker || sudo apt-get install -y docker.io   # pick your distro
sudo systemctl enable --now docker

# 2. copy the worker directory over
git clone https://github.com/gagan114662/dazl.git && cd dazl/worker

# 3. generate the shared token (save the output - it goes in BOTH env files)
openssl rand -hex 32

# 4. build and run
sudo docker build -t dazl-worker .
sudo docker run -d --name dazl-worker --restart unless-stopped \
  -e ADVANCED_WORKER_TOKEN='<paste token from step 3>' \
  -p 127.0.0.1:8787:8787 dazl-worker

# 5. health check
curl -s http://127.0.0.1:8787/health   # {"ok":true,"platforms":["reddit","x"],...}
```

The worker listens on loopback only. Expose it to the dazl.ai server either through
an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 ...` is for local testing; for production
put it behind the same private network / security group) or a TLS reverse proxy.
Never bind it to a public port without TLS - the bearer token is the only auth.

### systemd instead of Docker

```bash
sudo useradd -r -m -d /opt/dazl-worker dazl || true
sudo cp -r . /opt/dazl-worker && sudo chown -R dazl:dazl /opt/dazl-worker
echo 'ADVANCED_WORKER_TOKEN=<token>' | sudo tee /etc/dazl-worker.env
sudo cp dazl-worker.service /etc/systemd/system/
sudo systemctl enable --now dazl-worker
curl -s http://127.0.0.1:8787/health
```

## Env vars

Worker side:
- `ADVANCED_WORKER_TOKEN` (required) - shared bearer token. Generate: `openssl rand -hex 32`.
- `PORT` (default 8787).
- `X_QUERY_ID` (optional) - current X SearchTimeline query id. When X search starts
  returning empty/errors, open x.com in a browser, open devtools Network, run a
  search, find the `SearchTimeline` GraphQL request, copy the id from its URL here.
- `X_FEATURES` (optional) - full features JSON override for the same situation.

dazl.ai server side (the Next.js app env), so the app gates open and calls the worker:
- `ADVANCED_CONNECTORS=1`
- `ADVANCED_WORKER_URL` - e.g. `http://127.0.0.1:8787` or the tunnel/proxy URL.
- `ADVANCED_WORKER_TOKEN` - the same token.
- `ADVANCED_MAX_PER_HOUR` (optional, default 10) - per-tenant hourly cap per platform.
- `ADVANCED_KILL=1` - emergency off switch, checked on every call.
- LinkedIn stays off unless `ADVANCED_LINKEDIN=1` (highest ban risk, fetcher not built).

## Verifying end to end

1. `curl -s $ADVANCED_WORKER_URL/health` from the dazl.ai host.
2. In dazl Settings > Connectors, tier-1 platforms flip from "Off on this server" to
   connectable once `ADVANCED_CONNECTORS=1` and the worker env are set.
3. As a test account: accept the risk notice, paste a throwaway Reddit session
   cookie, run a scan with Reddit ticked, and check the lookup history for
   `adv:reddit` rows with results > 0.

## Tests

`npm test` - parser contracts (item shape matches what the dazl app validates) and
the HTTP auth/validation surface. No live platform calls in tests.

## Operator sessions (env)

If the request carries no tenant session, the worker falls back to these env vars:

- `X_SESSION_COOKIE` - `auth_token=...; ct0=...` for a throwaway X account
- `REDDIT_SESSION_COOKIE` - reddit_session cookie value
- `LINKEDIN_SESSION_COOKIE` - li_at cookie value (reserved; no LinkedIn handler yet)

`/health` reports `operator_sessions` as booleans only. Values are never logged.
With neither a tenant session nor an env session, /fetch answers 400 `no_session`.

## X fetcher rotation knobs

X rotates the SearchTimeline query id and required feature flags. `X_QUERY_ID` and
`X_FEATURES` env vars override the built-in values without a redeploy. When the
timeline call fails or returns 0 items, the fetcher falls back to the legacy
`search/adaptive.json` endpoint automatically; check worker logs for which path ran.
