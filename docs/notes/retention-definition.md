# Retention definition for #404: one shared implementation

Both #404 branches import one file, `web/lib/growth/retention.ts`, and its test file `web/test/growth-retention.test.ts`. They are byte-identical on `claude/epic-cannon-xrw9ut-acquisition-funnel` and on this branch, so merging the two leaves exactly one definition. Neither branch defines retention or coverage anywhere else.

There are two separate metrics, each with its own cohort and its own positive evidence. "No cancellation was recorded" is never evidence of anything.

| Metric | Cohort | Definition |
|---|---|---|
| **Retained at day 30** (historical) | Paying customers whose day-30 renewal window has closed by the cutoff: their first paid payment is at least 30 + 5 days old. | A paid, not refunded renewal inside days 25 to 35 after the first payment, and the subscription not ended by day 30 (ending exactly at day 30 counts as ended). A renewal after day 35, such as a lapse and then a rejoin, is not day-30 retention. |
| **Coverage at the cutoff** (current) | Every customer who has paid by the cutoff. | **covered:** a paid 30-day billing period includes the cutoff. **not covered:** an end was recorded and nothing was paid since. **unknown:** the last paid period ran out and no end was recorded. |

The settings live in `RETENTION`: `headline_days` 30, `renewal_early_days` 5, `renewal_late_days` 5, `period_days` 30. The 5-day values and the 30-day period are carried-over defaults, not owner decisions. Other values are only available by passing an explicit option.

The tests cover:
- one payment with no end, 200 days on: coverage unknown, not retained;
- a renewal at day 100: not retained;
- a rejoin: not retained, covered during the new period, not covered between the end and the rejoin;
- the window bounds, each to the second;
- the end-by-day-30 bound;
- each setting on its own;
- both cohorts named.
