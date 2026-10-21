# TinyFish search backend

Scans use TinyFish Search and Fetch when the operator sets `TINYFISH_API_KEY`. Otherwise (or on any TinyFish error, cap or empty result) scans use the provider's built-in web search on the tenant's own key, as before.

- Key: env var only, read on the server, sent only in the `X-API-Key` header to api.search.tinyfish.ai and api.fetch.tinyfish.ai. Never logged, stored in the DB or sent to the browser.
- Flow: the tenant's model writes up to 3 queries, TinyFish searches (last 12 months), fetches up to 8 pages as markdown, the model turns that into candidates (URL, verbatim quote, date), and the existing verifier re-fetches and checks each one.
- Caps (env, defaults): `TINYFISH_SEARCHES_PER_SCAN`=4, `TINYFISH_FETCHES_PER_SCAN`=8 URLs, `TINYFISH_TENANT_DAILY`=60 searches per tenant per UTC day, `TINYFISH_GLOBAL_SEARCH_DAILY`=3000, `TINYFISH_GLOBAL_FETCH_DAILY`=400, `TINYFISH_PER_MINUTE`=20. `TINYFISH_ENABLED=0` switches it off. 20 s timeout per call.
- 401/403 pause TinyFish for 10 min, 402 until 00:00 UTC, 429 for 60 s; scans fall back meanwhile.
- Docs: https://docs.tinyfish.ai/search-api , /fetch-api , /error-codes ; https://www.tinyfish.ai/pricing ; https://www.tinyfish.ai/terms
- Usage is counted in the `tinyfish_usage` table.
