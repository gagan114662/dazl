# dazl session worker

Operator-run companion for the web app's advanced (session-credential) connectors. The app
sends `POST /fetch` with `{platform, query, session}` and a bearer token; the worker replies
`{items:[{url,title,quote,date,login_walled}]}`. The session is one tenant's own cookie, sent
only for a scan they started, after they saved it and accepted the risk notice. The worker
stores nothing.

## Run

```
ADVANCED_WORKER_TOKEN=<shared secret> PORT=3210 npm start
```

Set the same token in the app (`ADVANCED_WORKER_URL=http://<host>:3210`, `ADVANCED_WORKER_TOKEN`)
plus `ADVANCED_CONNECTORS=1` (and `ADVANCED_LINKEDIN=1` for LinkedIn). Node 22+.

## Platform status (honest)

| platform    | fetcher                                        | tested with a live session? |
|-------------|------------------------------------------------|------------------------------|
| reddit      | reddit.com/search.json with the session cookie | parser unit-tested only      |
| x           | web GraphQL SearchTimeline, auth_token + ct0   | parser unit-tested only; the query id rotates, override with `X_SEARCH_QUERY_ID` |
| bilibili    | api.bilibili.com web search with SESSDATA      | parser unit-tested only; Bilibili may demand wbi signing, not implemented |
| instagram   | web topsearch with sessionid                   | parser unit-tested only      |
| linkedin    | voyager blended search with li_at + JSESSIONID | untested; app caps it at 3 calls/hour |
| facebook    | none (no cookie-only JSON search exists)       | returns [] by design         |
| xiaohongshu | none (web requests need x-s signing)           | returns [] by design         |

Facebook and XiaoHongShu return nothing until a browser-based fetcher or request signing is
built; the app records those as empty and their channels stay "Needs worker" in Settings.

X, Instagram, Facebook and LinkedIn disallow automated access in their terms. Tenants are told
this in the consent text before saving a session, and calls are rate-limited per tenant.
