# Retention definition: two #404 branches compared

Two branches define "retained" differently. This note sets out both, so the definitions are reconciled before the branches are combined.

## The ops funnel branch: 25/35 days

Branch: `claude/epic-cannon-xrw9ut-acquisition-funnel`, file `web/lib/growth/lifecycle.ts`.

- **Retained:** a second paid invoice, not fully refunded, landing at least 25 days after the first (`RETAIN_AFTER_S`).
- **Maturity:** a tenant whose first payment is less than 35 days old (`RETAIN_MATURE_S`) is not yet mature. Such tenants are left out of the retention rate.
- **What it measures:** whether the first renewal happened (month-2 retention).
- **What it does not check:** whether the customer is still paying today. For example, a tenant that paid twice and then stopped still reads as retained.

## This branch: 60 days, with current coverage

Branch: `claude/trusting-bell-xyya6m-lifecycle`, file `web/lib/gtm/lifecycle.ts`.

- **Retained:** two conditions must both hold.
  - A successful payment landed at least 60 days after the first one (`RETAINED_DAYS`).
  - The latest successful payment still covers today: one 30-day period plus 5 days of grace (`PAID_COVER_DAYS`).
- **Lapsed:** paid, but with no successful payment inside that cover window and no cancel event. A lapsed customer is not retained.
- **Maturity:** customers whose first payment is less than 65 days old (`RETENTION_MATURE_DAYS`) are left out of the retention rate.
- **What it measures:** whether a customer renewed at least twice on a monthly plan and is still paying.

The earlier head, `42924cfd`, retained anyone still "paying" 60 days after their first payment. That counted a single payment on day 3 as retained on day 200. The fix makes retention depend on a later payment, never on elapsed time alone. Tests in `web/test/gtm-lifecycle.test.ts` now cover these cases:

- one early payment → lapsed;
- renewals that all fall short of 60 days → paid;
- a renewal past 60 days followed by no further payments → lapsed;
- a failed payment after the renewal → payment_failed;
- a cohort that is not yet mature → excluded from the rate rather than counted as lost.

## Recommendation

Combine the two definitions on the ops branch, which Instinct has chosen as the direction:

1. **Keep ops' 25/35-day definition** as the headline retention metric. It is evidence-based (a second invoice), matures sooner, and is enough to judge month-2 retention while there are few customers.
2. **Add this branch's current-coverage check to it.** A customer whose latest successful payment is more than 35 days old should be lapsed, not retained. Without the check, the first-renewal definition goes on counting customers who stopped paying.
3. **If a longer horizon is wanted later,** report 60-day retention (a payment at least 60 days after the first, still covered) as a second, separately labelled metric. It should not redefine "retained".

Both branches share these rules:

- excluded customers are never counted;
- an immature cohort is never read as final;
- refunds and failed payments are never retained.

## Webhooks and event recording

The branches differ here:

- **The ops branch adds Stripe event recording.** In `web/lib/billing/stripe.ts`, the existing Stripe webhook handler writes lifecycle events into a new `lifecycle_events` table (migration 0018). The events are payment succeeded, payment failed, refund and subscription ended. This recording is not activated yet.
- **This branch adds no webhook, Stripe hook or table.** It is a pure function over events passed in by the caller.

## Same cutoff and eligible set

This branch now applies these rules (tests in `web/test/gtm-lifecycle.test.ts`):

- **One as-of cutoff for every row.** Signups, runs, payments and costs dated after as-of are left out (`upTo`). The cutoff is applied before de-duplication, so a replayed id with a later date cannot displace the original.
- **One eligible set for both sides of the retention rate.** Both the numerator and the denominator are paying customers whose first payment is old enough for the renewal to be due. A customer who is retained but not yet mature is in neither, so the rate cannot exceed 100%.
- **Maturity boundaries are tested.** One tick before maturity, the customer is in neither side; at maturity, in both.

The ops branch needs the same as-of cutoff on its users, scans and events queries.

## Shared definition (pending)

Instinct's pick is a 30-day headline with labelled current-coverage evidence, defined once and used by both implementations. The ops builder is adding it on `claude/epic-cannon-xrw9ut-acquisition-funnel`.

- **What the ops branch has now** (as of `4a6db2c4`): a 30-day window (`RETAIN_DAYS`, ±5 days of grace) computed inline inside `tenantFunnels`. It has no exported function and no current-coverage check yet.
- **What this branch will do:** once that shared definition is exported, drop its own 60-day rule (`RETAINED_DAYS`, `PAID_COVER_DAYS`) and import it, rather than keep a second definition.
