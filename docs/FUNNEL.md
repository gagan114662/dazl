# Dazl's own acquisition funnel (issue #404)

From dazl's own data: per tenant and per first-party acquisition source, **signup -> first real lead -> repeat useful scan -> paid -> retained**. Every definition lives in one place, `web/lib/growth/lifecycle.ts` (`DEFINITIONS`). Every number is computed at read time from rows the product writes when the thing happens; nothing is a hand-bumped counter.

## Where each step comes from
| Step | Source of truth |
| --- | --- |
| Signed up | `users.created_at` (one personal workspace = one tenant, counted once) |
| First real lead (activation) | a scan of the tenant's that **finished successfully** (status `done`; a failed, cancelled or unfinished scan's saved leads do not count) with at least one lead a user would see as verified: not held for review, scored, not quarantined, has a company, not hidden low-fit, not a test source, not held by a failed required gate. A scan with zero such leads is not activation, nor is entering a key or starting a scan. |
| Repeat | a second scan with real leads, started at least 24 h after the activating one |
| Paid | `lifecycle_events` `payment_succeeded` (a Stripe invoice paid, amount above 0) not fully refunded. A failed payment, a zero-amount (trial) invoice or a fully refunded one is not paid; a partial refund still is. Each `charge.refunded` is kept as its own row per charge and refunded total (history), and an invoice is fully refunded once any of them says so or the largest total reaches what was paid, whatever order they arrived in. |
| Retained (at N days, `--retain-days`, default 30) | a paid, not refunded invoice at least N-5 days after the first one: evidence of a renewal. Paid tenants whose first payment is under N+5 days old are not mature and stay out of the retention rate. |
| Churned | paid, then the subscription ended, without being retained |
| Source | the first-party tag on the sign-up link (`/sign-up?utm_source=...` or `?ref=...`), normalised; no tag is **unknown**, never guessed. A tag says where the link came from; it is not causal credit. |

Kept apart, so they are never mistaken for each other: signed up but never scanned, scanned with no real lead, payment failed, refunded, paid, retained, churned.

`lifecycle_events` is append-only and idempotent (one row per kind and reference): the Stripe webhook writes payments, failures, refunds and subscription ends in the same transaction as the event's processed record, so a redelivered event, or `invoice.paid` and `invoice.payment_succeeded` for the same invoice, is one payment. Password sign-up writes the source tag. Nothing goes to a third party.

**Excluded:** synthetic and staging tenants, meaning accounts at reserved test domains (`example.com/.net/.org`, `*.test`, `*.example`, `*.invalid`, `*.localhost`), plus any ids passed with `--exclude`. Their count is reported.

## Retention: the two definitions on the table (owner decision)
The other lifecycle branch (`claude/trusting-bell-xyya6m-lifecycle`) counts a tenant **retained when 60 days have passed since the first payment without a cancellation**. This one counts **retained at N days when a renewal was actually paid** (a paid, not refunded invoice at least N-5 days after the first), and leaves tenants younger than N+5 days out as not mature.
- They differ when a renewal fails or is refunded without a cancellation event (counted as retained there, not here), and in the window (60 there, 30 by default here; `--retain-days 60` gives the same window here).
- Recommendation: keep the evidence rule, since a renewal that was paid is the outcome, and choose N per plan (30 for monthly is one renewal). The window is one number; the rule is the same.

## Report
```bash
cd web
node --experimental-strip-types --no-warnings scripts/funnel.mts --db /var/lib/dazl-next/app.db --markdown
```
It opens the store read-only. `--tenants` adds per-tenant rows (id, source and stage only; no email). JSON is the default.

## Not done here (needs the owner, or a later increment)
- **Stripe:** the webhook must also send `invoice.paid` and `charge.refunded` (docs/PLATFORM.md). Until then no payment appears. Payments made before this change are not in the funnel; Stripe's own history could be backfilled with a read-only script, which needs the owner's approval to read Stripe.
- **Google sign-in** carries no source tag yet, so it reads as unknown, and so does every account made before this change.
- **Cost** per activated or retained customer needs recorded acquisition spend per source, which dazl does not record.
- Prospect and qualified-conversation stages (#365/#366) and experiment linking are not joined in yet.
- **Team workspaces:** a team workspace's own scans are not yet attributed to it.
- **A dashboard page:** the report is a command for now.
