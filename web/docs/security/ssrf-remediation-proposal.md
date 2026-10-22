# SSRF remediation proposal (F4 / F5)

Status: proposal only. No existing file is modified here; implementation waits for
the primary engineer's ownership confirmation on the touched files. Companion to
`tenant-isolation-assessment.md` findings F4 and F5.

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
