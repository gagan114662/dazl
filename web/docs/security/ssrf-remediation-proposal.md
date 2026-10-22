# SSRF remediation proposal (F4 / F5)

Status: IMPLEMENTED on branch security/tenant-isolation-assessment (ownership
confirmed by the primary engineer). Companion to `tenant-isolation-assessment.md`
findings F4 and F5. F1 (CSV formula escaping) and F2 (per-tenant enrichment rate
limit) landed in the same branch.

Implementation notes:
- `lib/net/public-fetch.ts` gained additive options (`accept`, `acceptHeader`,
  `userAgent`, `maxBytes`, `timeoutMs`, `method`, `body`, `headers`); GET-HTML
  defaults are unchanged for the existing ICP-from-site caller. HTTP-error and
  content-type blocks now carry the response `status` so callers can show it.
- SEO audit and newsjack call the guard with `accept: null` to preserve their
  old any-content-type behavior; request UA/Accept headers, timeouts and size
  caps are unchanged. Redirects are re-validated per hop (before, plain
  `redirect: 'follow'`).
- `normalizeDomain` no longer accepts `localhost`.
- CRM webhook: save-time host validation in the route plus push-time pinned
  POST. Deliberate narrowing: webhook redirects are no longer followed; a
  redirecting endpoint gets its 3xx reported as an error instead.
- Enrichment settings POST now authenticates first and rate-limits per tenant
  (`settings:enrichment:<user id>`); no route-level test harness exists in this
  repo for API routes, so that change is covered by tsc + review, not a test.
- Regression tests: `web/test/isolation-fixes.test.ts` proves the callers route
  through the guard (injected DNS, zero egress on block) and pins the CSV
  escaping; `web/test/isolation-ssrf-guard.test.ts` pins the guard itself.

## Problem (demonstrated unsafe primitive, not a proven production exploit)

Three fetch paths accept tenant-influenced URLs and issue plain `fetch` calls
with `redirect: 'follow'` and no IP validation or pinning:

1. `web/lib/seo/audit.ts` `get()` - fetches `https://<domain>/` and `/robots.txt`.
   `normalizeDomain()` accepts `localhost` explicitly and any registrable-looking
   hostname; a hostname can resolve to, or redirect to, a non-public address.
   Parsed page content (title, description, h1s, canonical, robots sitemaps) is
   returned to the tenant in the audit response - a read channel.
2. `web/lib/seo/newsjack.ts` `fetchArticle()` - fetches any tenant-supplied
   `https://` URL. The article title is stored and returned; the excerpt feeds
   the tenant's LLM draft - an indirect read channel.
3. `web/app/api/crm/route.ts` + `web/lib/crm/index.ts` - the tenant's webhook URL
   (any `https://` string) receives POSTs at push time. Blind SSRF only (the
   response is not returned), but it still lets a tenant make the server contact
   internal HTTPS endpoints.

The repo already has the guarded primitive these paths should use:
`web/lib/net/public-fetch.ts` (non-public IP rejection incl. link-local/cloud
metadata and CGNAT, address pinned at connect time so DNS rebinding cannot swap,
every redirect hop re-validated, size and time caps). Its guard semantics are now
pinned by `web/test/isolation-ssrf-guard.test.ts`.

## Proposed changes (small, per file)

### 1. `web/lib/net/public-fetch.ts` (one additive option)

Add an optional `accept`/`maxBytes` override to `fetchPublicHtml`'s deps so
non-HTML targets (robots.txt, sitemap XML) can share the guard. No change to
existing behavior when the option is absent.

### 2. `web/lib/seo/audit.ts`

- Replace `get()`'s plain fetch with the guarded fetcher (both the homepage and
  robots.txt fetches).
- Remove `localhost` from the `normalizeDomain` allow-regex.
- Map guard errors to honest user copy: `not_public` -> "That address is not on
  the public internet", `timeout` -> existing timeout copy.
- Keep `final_url` reporting; the guard already re-validates each hop.

### 3. `web/lib/seo/newsjack.ts`

- Replace `fetchArticle`'s plain fetch with the guarded fetcher
  (`accept: text/html`). On `not_public` return the existing `fetch` error copy
  ("Check the link is public") - it already says the right thing.

### 4. CRM webhook (`web/app/api/crm/route.ts` + `web/lib/crm/index.ts`)

- At save time: reject a webhook URL whose host is not public
  (`resolvePublic`), with the same error copy style as the route uses now.
- At push time (load-bearing): route the POST through the pinned guard - DNS
  can be re-pointed after saving, so save-time validation alone is bypassable.

## Regression tests to land with the fix PR

- `normalizeDomain('localhost')` -> null; `normalizeDomain('10.0.0.5')` -> null.
- `runAudit(db, tenant, 'metadata.example')` with an injected lookup returning
  169.254.169.254 -> `{ error: ... }`, and no content returned.
- `createNewsjack(db, tenant, 'https://internal.example/')` with an injected
  lookup/fetch pair simulating a redirect to a private address -> `{ error: 'fetch' }`.
- CRM: `saveCrmConfig` rejects `https://169.254.169.254/hook`; push to a host
  re-pointed to a private address after save never leaves the guarded path.

## What this does not cover

- The guarded fetcher protects HTTP(S) egress only; it does not rate-limit
  per tenant (audit has a 10/hour limiter already; newsjack 10/hour; CRM 20/min).
- IMDSv2 on the EC2 box is still worth enforcing deploy-side as defense in depth;
  that is outside this repo.
