# #413 live check: reply/opt-out reading for first-touch-only outreach

Staging only, $0. Uses the test-only fake reply source from PR #1286 (`DAZL_STAGING_FAKE_REPLIES=1`, staging + stub Gmail only; production never reads the flag).

## Setup (on the staging box)
1. Confirm `DAZL_STAGING_FAKE_REPLIES=1` is in the running staging process (already done 2026-11-16, staging b495ee17).
2. Record the start time: `export CHECK_SINCE=$(date +%s)`.
3. On a read-consented staging test tenant with **no sequence and sending paused**, send first touches to:
   - `staging+fake-optout@<test domain>` (fake source replies "Please unsubscribe me.")
   - `staging+none-control@<test domain>` (no reply; negative control)
   - on a second test tenant (or the same one), `staging+fake-syncerror@<test domain>` (Gmail answers 500), then approve one more message on that tenant but do not send it.
4. Wait for one tick (~5 min) or run the internal tick.
5. Try one more send to the opt-out address (it must be refused `suppressed`).

## Run
```sh
DAZL_DB=/path/to/staging.sqlite \
CHECK_TENANT_ID=<tenant> CHECK_SYNCERR_TENANT_ID=<tenant with the sync-error thread> \
CHECK_OPTOUT_EMAIL=staging+fake-optout@<domain> CHECK_CONTROL_EMAIL=staging+none-control@<domain> \
CHECK_SINCE=$CHECK_SINCE python3 ops/checks/413-reply-optout/check.py
```
Exit 0 and `RESULT: PASS` only if every criterion passes. Paste the output on #413.

`python3 ops/checks/413-reply-optout/check.py --self-test` proves the checks PASS a working DB and FAIL a broken one.

## Covers
AC-1 opt-out ingested on tick without a sequence (sending paused) · AC-2 address suppressed · AC-3 no further email (second send refused/skipped) · AC-4 partial sync error marks freshness unknown and the held send stays unsent · negative control (no-reply address not ingested/suppressed; the tick really read threads).

Not covered here: "revoked read consent makes zero provider calls". That's proven by the unit tests in PR #1286, since the fake source can't count real provider calls.
