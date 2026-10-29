# Scheduler heartbeats, progress and overdue alerts (issue #361)

`POST /api/internal/tick` runs the scheduled work: reply sync and follow-ups for tenants with autopilot on, sequence steps 2 and 3, watches, monitors and index checks. It is called by an external cron or systemd timer with `AUTOPILOT_TICK_SECRET` (docs/AUTOPILOT.md).

This document covers how to tell whether that work is **actually happening**. Whether it is **configured** to happen is a separate question.

## Configuration vs. operation

| | answers | where |
|---|---|---|
| Configuration | is sending switched on: operator switch, kill switch, the tenant's pause, Gmail connected, reply consent, sender identity, no uncertain send | `lib/outreach/scheduler-readiness.ts`, as `scheduler` and `gates` in `GET /api/outreach/sequences` |
| Operation | is the scheduler completing runs, and is each tenant's work succeeding and keeping up | `lib/ops/scheduler-runs.ts`, as `freshness` in the same response (the tenant's own rows), and `GET /api/health/scheduler` (operator: counts only) |

A scheduler can be configured on and still stale, for example when cron was never installed. The Outreach page shows the two separately.

## What is recorded (durably, in the app's store)

- **`scheduler_runs`, one row per tick.** Records start and finish time, and the status: `running`, `ok`, `partial` (some tenant failed), `failed` or `lease_lost`. Also records the lease owner and **generation** it ran under (the fencing token, lib/shared/lease.ts), tenants attempted and failed, and a scrubbed error. The row is written when the tick starts, before any work, so a tick whose process dies leaves a `running` row. The last 2000 runs are kept.
- **`scheduler_progress`, one row per tenant and kind of work** (`reply_sync`, `followups`, `sequences`). Records the last attempt, last success, last failure reason and consecutive failures.
  - The failure reason is the error's class plus the first line of its message, with addresses, tokens and query strings removed, at most 200 characters.
  - A success is recorded only after the work returned, so its writes passed the lease fence.
- **The oldest due item is computed, not stored.** It is the earliest due time of a sequence step that should have been sent by now: step 1 sent, the next step's +3 or +7 days passed, the sequence still approved or active.

## States and thresholds

The tick is expected every 15 minutes.

| state | meaning | threshold |
|---|---|---|
| `never_ran` | no run recorded | |
| `running` | a run in progress, and the previous completion is recent | |
| `fresh` | last completed run (`ok` or `partial`) is recent | within `STALE_AFTER_S` = 45 min (3 missed ticks) |
| `stale` | no completed run within 45 min: cron off, the route returning 404 (no secret), or every run failing | |
| `crashed` | the newest run started more than `CRASHED_AFTER_S` = 30 min ago (the lease TTL) and never finished: the process died inside a tick | |

A tenant is:
- **blocked** when one kind of work has failed `BLOCKED_AFTER_FAILURES` = 3 times in a row;
- **stale** in any of these cases:
  - its reply sync has had no success for `REPLY_SYNC_STALE_S` = 2 h while still being attempted;
  - a due step is more than `OVERDUE_ALERT_S` = 1 h overdue;
  - the scheduler itself is stale, crashed or never ran while the tenant has work.

Otherwise it is **healthy**, or **idle** if it has no scheduled work. The thresholds are constants in `lib/ops/scheduler-runs.ts`.

`GET /api/health/scheduler` answers 200 when there is no problem and 503 otherwise. It returns:
- the scheduler's own state and the last completed run's age;
- the lease generation and the error **class** of the last run;
- counts across tenants: tracked, blocked, reply sync stale, overdue, oldest overdue.

It contains no tenant id, name or error text. It is not part of `/api/ready`, so a stalled scheduler never blocks a deploy or restarts a healthy web process.

## Alerts

`web/scripts/ops/scheduler-check.mts` runs every 5 minutes from `ops/scheduler/dazl-scheduler-check.timer`, which is a template and not installed.
- It reads `/api/health/scheduler` on loopback.
- When the endpoint is not ok or does not answer, it alerts `OPS_ALERT_WEBHOOK_URL` (https; a free Slack incoming webhook works).
- The same kinds of problem alert at most once an hour.
- A recovery is announced once.

## Operator runbook

| alert | check | action |
|---|---|---|
| `scheduler never ran` with work waiting | Is the tick's cron or timer installed and enabled? Is `AUTOPILOT_TICK_SECRET` set in the app's env file? Without it the route is a 404. | install or enable the scheduler (docs/AUTOPILOT.md). This is an owner/Instinct production change. |
| `scheduler stale` | The cron/timer journal: does the call return 200? `last_error_class` in the health response. | fix the caller or the failing step. A 404 means the secret is missing or mismatched. |
| `scheduler crashed` | The app journal around `running_since`: OOM, restart or deploy. | Nothing to clean up. The next tick takes over once the lease expires (at most 30 min after the crash) at a new generation, and its run reads fresh. Unfinished sends from the dead run are handled by the claim machinery: `sending` claims older than 10 min become `uncertain` and are never resent automatically (docs/STAGING.md send-safety scenarios). Resolve those before resuming. |
| `N tenant(s) blocked` | `scheduler_progress` rows with `consecutive_failures >= 3` and their `last_error` (operator DB access only; never in alerts). | Usually a disconnected Gmail account or withdrawn reply consent. The tenant sees "Scheduled work is blocked" on their Outreach page. |
| `reply sync stale` | the same rows, `kind = 'reply_sync'` | Same as blocked. Gmail token refresh failing, or rate limits. |
| `due work overdue` | Is the scheduler fresh? If yes, look at the tenant's `sequences` progress and whether a pause or an uncertain send is holding it: the gates in `GET /api/outreach/sequences`. | A configured hold (pause, uncertain send, kill switch) is expected to leave work due, so check the gates first. |

A recovered run resumes safely:
- each tick re-reads due work from the store;
- the lease generation fences a stale holder's writes;
- sends go through the same claim, uncertain and approval-hash checks as always.

## Not done here

- Installing the tick's own timer and the check timer on the host: Instinct, after the owner confirms the alert destination.
- Per-tenant progress for watches, monitors and index checks: they are recorded only in the run's totals today.
- Retention of `scheduler_progress` rows for deleted tenants: tied to #359's deletion lifecycle.
