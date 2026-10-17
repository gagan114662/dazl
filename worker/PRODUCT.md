# Product layer

What a tenant can do today, how it is protected, and what you must configure.
Builds on `MULTITENANCY.md` (isolation, API keys, cutover runbook).

## Tenant dashboard

`GET /app` serves a single-page dashboard (overview and usage meters, team,
leads, drafts, creatives). It contains no data; it signs in with a tenant API
key kept in `sessionStorage` and calls the `/v1` API. Strict nonce CSP, no
`innerHTML`, every value rendered with `textContent`.

## Plans and quotas

| | free | pro |
|---|---|---|
| Employees | 2 | 25 |
| Cycles / month | 100 | 5,000 |
| LLM calls / month | 200 | 10,000 |
| Emails sent / month | 50 | 2,000 |

Limits live in `src/runtime/plans.ts` (placeholders; set real ones before
launch). Over-limit requests return `402 {error:"quota_exceeded", kind, used,
limit}`. The cron wake skips over-quota tenants without billing a cycle.
The `default` (pre-multitenancy) tenant is set to `pro`.
`GET /v1/usage` reports consumption. Admin: `PUT /v1/tenants/:id/plan`.

### Stripe

`POST /v1/billing/checkout` creates a Checkout session for the pro price
(`client_reference_id` = tenant id). `POST /v1/billing/webhook` verifies the
`Stripe-Signature` HMAC (5-minute replay window) and applies
`checkout.session.completed` (-> pro) and `customer.subscription.deleted`
(-> free). Secrets: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`,
`STRIPE_WEBHOOK_SECRET`, plus `PUBLIC_BASE_URL`. Not exercised against live
Stripe: only signature logic and event handling are tested.

## Outbound (Gojiberry-style)

1. `PUT /v1/icp` (ideal customer + offer) and `PUT /v1/profile` (sender name +
   postal address; both required before any email can send).
2. `POST /v1/leads` imports up to 100 leads (emails lowercased, deduped per
   tenant, suppressed addresses imported as `suppressed`).
3. `POST /v1/leads/:id/score` -> 0-100 score + reason from the model.
4. `POST /v1/leads/:id/draft` -> email draft (status `draft`).
5. Human review: `PATCH /v1/drafts/:id` (edit, only while `draft`),
   `POST .../approve` or `.../reject`.
6. `POST /v1/drafts/:id/send` sends only `approved` drafts.

Safety properties (all tested):
- Nothing is sent without explicit approval; approved drafts cannot be edited.
- Atomic `approved -> sending` claim: concurrent sends deliver at most once.
- Suppression list checked at import, draft, and send time.
- Every email carries sender identity, postal address, and an HMAC-signed
  one-click unsubscribe link (`GET /unsubscribe`).
- Lead/ICP text reaches the model inside `<data>` delimiters with an
  untrusted-input instruction; model output is only stored for human review.
- Provider errors never reach the caller; failed sends are not metered.

Email goes through Resend: set `RESEND_API_KEY`, `EMAIL_FROM` (a verified
sending domain), `PUBLIC_BASE_URL`, and ideally `UNSUBSCRIBE_SECRET` (falls
back to `DAZL_API_SECRET`). Until set, `send` returns 503.

## Creatives (Gooseworks-style)

`POST /v1/creatives {channel, brief, brandVoice?}` returns 3 copy variants
(headline, body, CTA) for linkedin / x / instagram / facebook / tiktok /
email; `GET /v1/creatives` lists them.

## Operations

- `LLM_MODEL` (default `claude-sonnet-4-5`; confirm it is current for your
  account) selects the generation model; uses `ANTHROPIC_API_KEY`.
- Structured JSON logs (`log.ts`) carry `tenantId`, `event`, `level`.
- Sandbox `max_instances` raised 1 -> 5 in `wrangler.toml`; each concurrent
  tenant brain is a billed container, so set this to your cost tolerance.
- CI: `.github/workflows/worker-ci.yml` runs typecheck + tests on PRs.
- Migration `0004_product.sql` is additive (new tables, 4 new `tenants`
  columns). Deploy after 0002/0003 per the runbook in `MULTITENANCY.md`.

## Not built (be honest with customers)

- LinkedIn/DM automation (no sanctioned API; ToS risk).
- Live lead discovery from intent signals (leads are imported, not found).
  Employees currently research but do not yet feed leads automatically.
- Publishing creatives to Meta/TikTok/X, image/video generation, and creative
  performance measurement (needs per-tenant OAuth apps and review).
- Self-serve signup, email verification, password/SSO login, teams/roles.
  Tenants are provisioned by an operator (or Stripe) and sign in with an API key.
- Reply/bounce handling and a unified inbox.
- Live verification of Stripe, Resend, the Anthropic model name, and the
  sandbox container (all stubbed in tests).
- The macOS app still calls `/chat`, `/tts`, `/transcribe-token` without
  auth; set `PROXY_SHARED_SECRET` only after shipping a client that sends it.

## Known limitations

- Quotas (employees, cycles, LLM calls, emails) are reserved atomically; the
  headcount and lead-cap checks are check-then-insert and can overshoot by a
  few rows under heavy concurrency.
- No rate limiting on `/v1` or on key/secret guessing. Add Cloudflare WAF
  rate-limit rules in front of the Worker before public launch.
- Stripe events are applied idempotently (set-plan) but not ordered; a delayed
  `subscription.deleted` after a re-subscribe would downgrade until the next event.
- Unsubscribe is a GET so mail-scanner prefetch can unsubscribe a recipient
  (fails safe: no email is sent to them afterward).
- A crash between provider success and the `sent` update leaves a draft in
  `sending` (it is never re-sent, but needs manual reconciliation).
- The dashboard keeps the API key in `sessionStorage`; an XSS that bypassed
  the CSP could read it.
- `UNSUBSCRIBE_SECRET` falls back to `DAZL_API_SECRET`; set it separately.
