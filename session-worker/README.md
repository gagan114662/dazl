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
| facebook    | none (no cookie-only JSON search exists)       | 501 unsupported, not fetched |
| xiaohongshu | none (web requests need x-s signing)           | 501 unsupported, not fetched |

Facebook and XiaoHongShu have no fetcher (`UNSUPPORTED` in `src/fetchers.ts`; the app keeps the
same list in `web/lib/advanced/config.ts`). The worker answers them `501 {error:'unsupported'}` and
fetches nothing; the app never calls it for them, offers no consent or session in Settings ("Coming
soon"), and a scan records `unsupported`, never an empty search.

Any answer but `200 {items}` is a non-2xx `{error}` naming why (`src/handle.ts`): `no_session`
(400), `unsupported` (501), or `auth`, `throttled`, `schema`, `upstream`, `worker_error` (502). The
app audits these as `no_session`, `unsupported`, `auth_failed`, `throttled`, `schema_error` and
`worker_error`. `200 {items:[]}` means the platform answered and found nothing.

X, Instagram, Facebook and LinkedIn disallow automated access in their terms. Tenants are told
this in the consent text before saving a session, and calls are rate-limited per tenant.
