# #413 live check: reply/opt-out reading for first-touch-only outreach

Staging only, $0. Uses the test-only fake reply source from PR #1286 (`DAZL_STAGING_FAKE_REPLIES=1`, staging + stub Gmail only; production never reads the flag).

## Setup (on the staging box)
1. Confirm `DAZL_STAGING_FAKE_REPLIES=1` is in the running staging process (already done 2026-11-16, staging b495ee17).
2. Record the start time: `export CHECK_SINCE=$(date +%s)` (epoch seconds, the unit dazl stores).
3. On a read-consented staging test tenant with **no sequence and sending paused**, send first touches to:
   - `staging+fake-optout@<test domain>` (fake source replies "Please unsubscribe me.")
   - `staging+none-control@<test domain>` (no reply; negative control)
   - on a second test tenant (or the same one), `staging+fake-syncerror@<test domain>` (Gmail answers 500), then approve one more message on that tenant but do not send it.
4. Wait for one tick (~5 min) or run the internal tick.
5. Try one more send to the opt-out address (it must be refused `suppressed`).
6. Note the three outreach message IDs this run created: the opt-out first touch (probe), the control first touch, and the approved-but-unsent message on the sync-error tenant (held). The check binds to these exact rows.

## Run
```sh
DAZL_DB=/path/to/staging.sqlite \
CHECK_TENANT_ID=<tenant> CHECK_SYNCERR_TENANT_ID=<tenant with the sync-error thread> \
CHECK_PROBE_MESSAGE_ID=<probe id> CHECK_CONTROL_MESSAGE_ID=<control id> CHECK_HELD_MESSAGE_ID=<held id> \
CHECK_OPTOUT_EMAIL=staging+fake-optout@<domain> CHECK_CONTROL_EMAIL=staging+none-control@<domain> \
CHECK_SINCE=$CHECK_SINCE python3 ops/checks/413-reply-optout/check.py
```
Exit 0 and `RESULT: PASS` only if every criterion passes. Paste the output on #413.

The two email vars are optional; if set, they must match the bound rows.

Fail-closed: a missing table or column (e.g. `reply_checked_at`), a missing bound row (probe/control/held), a row on the wrong tenant, or any evidence older than `CHECK_SINCE` is a FAIL, never a skip.

`python3 ops/checks/413-reply-optout/check.py --self-test` proves the checks PASS a working DB and FAIL six broken ones, including review findings F1 (the bound held message was sent while an unrelated approved row exists) and F2 (missing `reply_checked_at`, missing control, stale pre-start evidence).

## Covers
AC-1 opt-out ingested on tick without a sequence (sending paused) · AC-2 address suppressed · AC-3 no further email (second send refused/skipped) · AC-4 partial sync error marks freshness unknown and the held send stays unsent · negative control (no-reply address not ingested/suppressed; the tick really read threads).

Not covered here: "revoked read consent makes zero provider calls". That's proven by the unit tests in PR #1286, since the fake source can't count real provider calls.
