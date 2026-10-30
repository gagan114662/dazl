# Retention for #404: one implementation, two metrics

Retention and coverage are defined in exactly one place: `web/lib/growth/retention.ts`. Both reports import it, and this branch keeps no copy.

- **The acquisition funnel** (`web/lib/growth/lifecycle.ts`), on the ops branch `claude/epic-cannon-xrw9ut-acquisition-funnel`.
- **The cohort lifecycle report** (`web/lib/gtm/lifecycle.ts`), on this branch, `claude/trusting-bell-xyya6m-lifecycle`. This branch merges the ops branch, so `retention.ts` comes from ops' own history (`e9dc551a`).

All windows are named settings in `RETENTION`. They are carried-over defaults, not owner decisions:

| Setting | Default |
|---|---|
| `headline_days` | 30 |
| `renewal_early_days` | 5 |
| `renewal_late_days` | 5 |

## The two metrics

Each metric has its own cohort and its own label, and both are reported by `cohortReport`.

| Metric | Cohort | Answer |
|---|---|---|
| **Retained at day 30** (historical): `retention` | Paying customers whose day-30 renewal window (days 25–35 after the first payment) has closed. | Retained when a paid, unrefunded renewal falls inside the window and the subscription had not ended by day 30. The numerator and denominator come from the same cohort, so the rate cannot exceed 100%. |
| **Coverage at the cutoff** (current): `coverage` | Every customer who has paid by the cutoff. | One of three answers. **Covered:** a paid, unrefunded invoice's actual service period includes the cutoff and no recorded end of that subscription stopped it. Each subscription line keeps its own period; a gap between periods is not covered. **Not covered:** an end was recorded, or the cutoff falls in a gap. **Unknown:** no period covers the cutoff and no end was recorded. Unknown is never reported as covered. |

## How this branch feeds the shared module

`retentionOf` in `web/lib/gtm/lifecycle.ts` only maps this branch's events onto the module's input. Times are converted from ms to unix seconds.

- **Payments:** every paid `payment` event becomes a payment, with the service periods billing reported for it (one per subscription line). A payment with no period is a one-off charge and is no coverage evidence.
- **Refunds:** a `refunded` event marks the latest earlier unrefunded payment as refunded.
- **Recorded end:** each `cancel` ends its own subscription; one with no subscription ends all of them. A cancellation scheduled for the period end is not an end yet.
- **Cutoff:** the report's as-of time.

Every row is cut at that same as-of time before de-duplication (`upTo`). Future-dated rows and late replays therefore never count.

The per-customer stage reads the day-30 answer: `retained`, `not_retained`, or `paid` while the customer is not yet in the cohort. Money states (refunded, churned, payment_failed) take precedence over all three.

Tests in `web/test/gtm-lifecycle.test.ts` check the shared boundaries through this branch's events:

- the renewal window, both ends included, and one second outside each end;
- cohort entry when the window closes;
- an end exactly at day 30 counting as ended;
- the rate never exceeding 100%.

## Webhooks and event recording

- **The ops branch records Stripe events.** In `web/lib/billing/stripe.ts`, the existing Stripe webhook handler writes payment succeeded, payment failed, refund and subscription ended into the `lifecycle_events` table (migration 0018). This recording is not activated yet.
- **This branch's own lifecycle code adds no webhook, Stripe hook or table.** It is a pure function over events the caller passes in.
