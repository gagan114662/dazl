# Retention definition for #404: one shared rule

Both #404 branches now use the same retention definition. It lives in `web/lib/growth/retention.ts`, added on the ops branch `claude/epic-cannon-xrw9ut-acquisition-funnel` in `235c3284`.

This branch (`claude/trusting-bell-xyya6m-lifecycle`) carries byte-identical copies of two files from that branch:

- `web/lib/growth/retention.ts` (blob `e354d5d7`);
- its test file, `web/test/growth-retention.test.ts`.

Because the copies are identical, merging the two branches produces no conflict and still leaves exactly one definition. Neither branch defines retention anywhere else. This branch's earlier 60-day rule, its own coverage window and its 'lapsed' stage are gone.

## The rules, stated explicitly

All three windows come from `RETENTION` in `retention.ts`: `headline_days` = 30 and `grace_days` = 5. Instinct confirmed that the 5-day grace is the existing default, not a requirement Instinct chose. Other windows are only available by passing an explicit option.

| Rule | Definition | Tested at its boundary |
|---|---|---|
| **Eligible** (counts toward the rate) | The first paid, not refunded payment is at least headline + grace (35) days before the cutoff. | Eligible at exactly 35 days, not one second before. |
| **Renewal evidence** | A paid, not refunded payment at least headline − grace (25) days after the first one, on or before the cutoff. | Counts at exactly 25 days, not one second before. A refunded renewal is no evidence. |
| **Coverage evidence** | The subscription had not ended by first payment + headline (30) days. | Ending exactly at day 30 means not covered; one second later, covered. |
| **Retained** (the headline) | Eligible, with both renewal and coverage evidence. `null` while not eligible. | |
| **Rate** | `retentionRate`: numerator and denominator are the same eligible set, so the rate cannot exceed 100%. It is shown with `RETENTION.label`. | Renewed-but-young customers are in neither count. |
| **Covered at cutoff** | Whether the subscription is still running at the cutoff. Reported beside the headline (`coveredAtCutoff`), never mixed into it. | |

## How this branch feeds the shared definition

`retentionOf` in `web/lib/gtm/lifecycle.ts` only maps this branch's events onto the module's input. Times are converted from ms to unix seconds.

- **Payments:** every `payment` event with status `paid`.
- **Refunds:** a `refunded` event marks the latest earlier paid payment that is not already refunded.
- **End of subscription:** the first `cancel` on or after the first unrefunded payment.
- **Cutoff:** the report's as-of time.

Every row is cut at the same as-of time before de-duplication (`upTo`). Future-dated rows and late replays of an existing id therefore never count, and a customer seen only after as-of is not counted, not even as excluded.

The per-customer stage reads the shared result:

- `retained` when it says retained;
- `not_retained` when the customer is eligible but not retained;
- `paid` while not yet eligible.

Money states (refunded, churned, payment_failed) take precedence over these.

## Webhooks and event recording

- **The ops branch records Stripe events.** In `web/lib/billing/stripe.ts`, the existing Stripe webhook handler writes payment succeeded, payment failed, refund and subscription ended into a new `lifecycle_events` table (migration 0018). This recording is not activated yet.
- **This branch adds no webhook, Stripe hook or table.** It is a pure function over events the caller passes in.
