# Dazl's own acquisition funnel (issue #404)

From dazl's own data: per tenant and per first-party acquisition source, **signup -> first real lead -> repeat useful scan -> paid -> retained**. Every definition lives in one place, `web/lib/growth/lifecycle.ts` (`DEFINITIONS`). Every number is computed at read time from rows the product writes when the thing happens; nothing is a hand-bumped counter.

## Where each step comes from
| Step | Source of truth |
| --- | --- |
| Signed up | `users.created_at` (one personal workspace = one tenant, counted once) |
| First real lead (activation) | a scan of the tenant's that **finished successfully** (status `done`; a failed, cancelled or unfinished scan's saved leads do not count) with at least one lead a user would see as verified: not held for review, scored, not quarantined, has a company, not hidden low-fit, not a test source, not held by a failed required gate. A scan with zero such leads is not activation, nor is entering a key or starting a scan. |
| Repeat | a second scan with real leads, started at least 24 h after the activating one |
| Paid | `lifecycle_events` `payment_succeeded` (a Stripe invoice paid, amount above 0) not fully refunded. A failed payment, a zero-amount (trial) invoice or a fully refunded one is not paid; a partial refund still is. Each `charge.refunded` is kept as its own row per charge and refunded total (history), and an invoice is fully refunded once any of them says so or the largest total reaches what was paid, whatever order they arrived in. |
| Retained at day 30 (historical) | `web/lib/growth/retention.ts`, the one file both funnel reports import. **Cohort:** paying tenants whose day-30 renewal window (days 25 to 35 after the first payment) has closed by the cutoff. **Retained:** a paid, not refunded renewal inside that window, and no subscription end before day 30. A renewal after the window (a lapse, then a rejoin) is not day-30 retention. The 5-day early/late bounds and the 30-day period are named defaults, not owner decisions. |
| Covered at the cutoff (current) | A separate metric. **Cohort:** every tenant that has paid by the cutoff. **covered:** a paid 30-day billing period includes the cutoff. **not covered:** a subscription end was recorded and nothing was paid since. **unknown:** the last paid period ran out and no end was recorded. No end event means only that none was recorded, never coverage. |
| Churned | paid, then the subscription ended, without being retained |
| Source | the first-party tag on the sign-up link (`/sign-up?utm_source=...` or `?ref=...`), normalised; no tag is **unknown**, never guessed. A tag says where the link came from; it is not causal credit. |

Kept apart, so they are never mistaken for each other: signed up but never scanned, scanned with no real lead, payment failed, refunded, paid, retained, churned.

`lifecycle_events` is append-only and idempotent (one row per kind and reference). **This branch changes the Stripe webhook handler** (`lib/billing/stripe.ts`): it records payments, failures, refunds and subscription ends in the same transaction as the event's processed record, so a redelivered event, or `invoice.paid` and `invoice.payment_succeeded` for the same invoice, is one payment. Password sign-up writes the source tag. Nothing goes to a third party.

**Excluded:** synthetic and staging tenants, meaning accounts at reserved test domains (`example.com/.net/.org`, `*.test`, `*.example`, `*.invalid`, `*.localhost`), plus any ids passed with `--exclude`. Their count is reported.

## Retention: one shared definition
Both implementations (this funnel and the cohort lifecycle report on `claude/trusting-bell-xyya6m-lifecycle`) import `retention()` and `retentionRate()` from `web/lib/growth/retention.ts`; neither defines retention itself. Day-30 retention and current coverage are two metrics with their own cohorts and their own positive evidence. Another headline window is only an explicit option (`--retain-days`).

## As of the cutoff
Every count is as of the report's cutoff (`--now`): accounts created, scans started, scans finished, leads saved and lifecycle events after it are not read, whatever order they arrived in. A payment, refund or cancellation replayed or dated after the cutoff does not change a report for an earlier cutoff.

## Report
```bash
cd web
node --experimental-strip-types --no-warnings scripts/funnel.mts --db /var/lib/dazl-next/app.db --markdown
```
It opens the store read-only. `--tenants` adds per-tenant rows (id, source and stage only; no email). JSON is the default.

## Not done here (needs the owner, or a later increment)
- **Stripe:** the webhook handler records these events (code in this branch), but it is **not activated**: the Stripe endpoint must also send `invoice.paid` and `charge.refunded` (docs/PLATFORM.md), an owner change in Stripe's dashboard. Until then no payment appears. Payments made before this change are not in the funnel; Stripe's own history could be backfilled with a read-only script, which needs the owner's approval to read Stripe.
- **Google sign-in** carries no source tag yet, so it reads as unknown, and so does every account made before this change.
- **Cost** per activated or retained customer needs recorded acquisition spend per source, which dazl does not record.
- Prospect and qualified-conversation stages (#365/#366) and experiment linking are not joined in yet.
- **Team workspaces:** a team workspace's own scans are not yet attributed to it.
- **A dashboard page:** the report is a command for now.
