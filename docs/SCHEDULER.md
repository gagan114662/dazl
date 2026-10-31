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
- **`scheduler_progress`, one row per tenant and kind of work** (`reply_sync`, `followups`, `sequences`, and `autopilot`: the first-touch drain, #411). Records the last attempt, last success, last failure reason, consecutive failures, and the outcome of the last attempt (`last_outcome`: `success`, `hold` or `failure`) with the hold's reason (`last_hold`).
  - The failure reason is the error's class plus the first line of its message, with addresses, tokens and query strings removed, at most 200 characters.
  - A result is recorded only after the work returned, so its writes passed the lease fence.
- **The oldest due item is computed, not stored.** It is the earliest due time of a sequence step that should have been sent by now: step 1 sent, the next step's +3 or +7 days passed, the sequence still approved or active.

## What the tick records for each worker result

The workers report ordinary refusals as a result (`stopped`), not an exception. The tick classifies what came back (`classifyWork`, `classifySync` in `lib/ops/scheduler-runs.ts`) before it records progress, so a refused or non-running worker is never a successful pass:

| outcome | meaning | progress row |
|---|---|---|
| `success` | work was done, or there was genuinely nothing due | `last_success_at` = now; `last_error`, `last_hold` cleared; `consecutive_failures` = 0 |
| `hold` | a legitimate configuration or idle state: the tenant's own hold | `last_attempt_at` = now, `last_hold` = the reason; `last_success_at`, `last_error` and `consecutive_failures` unchanged |
| `failure` | an operational refusal or failure | `last_error` = the reason; `consecutive_failures` + 1; `last_success_at` unchanged |

| worker | result | outcome |
|---|---|---|
| `runFollowups`, `runSequences` | returned without `stopped` (sent, skipped, activated, or nothing due) | success |
| both | `daily_cap`, `paused`; `runFollowups` `autopilot_off`, `followups_off`; `runSequences` `changed_since_approval` | hold; **success** if the same tick sent or activated something first |
| both | `uncertain_send`, `gmail_unavailable`, `gmail_or_identity` | failure (an uncertain send outranks earlier progress in the same tick) |
| `runFollowups` | `not_available` (operator switch off or kill switch, while the tenant has follow-ups on) | failure |
| `runAutopilot` (first touches, #411) | `daily_cap`, `paused`, `off`, `autopilot_off`, `consent_required`, `gmail_not_connected`, `gmail_reconnect_needed` | hold (the tenant's own switch, consent or mailbox); **success** if the same tick sent something first |
| `runAutopilot` | `not_available` / `autopilot_unavailable` (operator switch off or kill switch), `uncertain_send`, `authority_unreadable`, `reservation_lost`, a thrown error | failure |
| `disable()` (the tenant turns autopilot off) | writes one `autopilot` hold row `off` with `consecutive_failures` 0: the tick no longer runs this tenant's drain, so an earlier failure must not keep it blocked | hold |

The operator switch / kill switch is a failure for every enabled tenant's drain, as it is for follow-ups: after `BLOCKED_AFTER_FAILURES` ticks every such tenant reads as blocked (`autopilot_failing`) until the switch is back and a tick succeeds.
| `runSequences` | `sequences_disabled` (operator switch off or kill switch, while the tenant has approved or active sequences), `reading_not_enabled`, `reply_sync_failed` | failure |
| `syncReplies` | `error` (`reading_not_enabled`, `gmail_unavailable`, `reply_sync_failed`) | failure; follow-ups are not attempted that tick |
| any | a thrown error, or a `stopped` reason the tick does not know | failure (an unknown refusal is never read as progress) |

An operator switch that is off while tenants have work is deliberate, and still a failure here: the tick is running and refusing the work, and the alert after three ticks is the reminder. A tenant's own pause, cap or withdrawn consent is a hold: it is not progress, but nothing is failing. A hold does not resolve earlier failures either: a tenant blocked by three failures stays blocked while paused, until a run succeeds.

A run is `partial` when some work failed; holds alone leave it `ok`. The tick's response carries `tenant_failures` and `tenant_holds`.

## States and thresholds

The tick is expected every 15 minutes.

| state | meaning | threshold |
|---|---|---|
| `never_ran` | no run recorded | |
| `running` | a run in progress, and the previous completion is recent | |
| `fresh` | last completed run (`ok` or `partial`) is recent | within `STALE_AFTER_S` = 45 min (3 missed ticks) |
| `stale` | no completed run within 45 min: cron off, the route returning 404 (no secret), or every run failing | |
| `crashed` | the newest run started more than `CRASHED_AFTER_S` = 30 min ago (the lease TTL) and never finished: the process died inside a tick | |

Separately from the state, the health response carries `unresolved_failure`: the latest finished run ended `failed` or `lease_lost`, and no run has completed `ok` or `partial` since. It is a problem, and so an alert, even while an earlier success keeps the state `fresh`: a recent success proves the scheduler was making progress, not that the newer tick worked. A run in progress does not clear it; the next successful run does.

A tenant is:
- **blocked** when one kind of work has failed `BLOCKED_AFTER_FAILURES` = 3 times in a row;
- **stale** in any of these cases:
  - its reply sync has had no success for `REPLY_SYNC_STALE_S` = 2 h while still being attempted;
  - a due step is more than `OVERDUE_ALERT_S` = 1 h overdue;
  - the scheduler itself is stale, crashed or never ran while the tenant has work.

- **held** when nothing is failing or stale and the last attempt at some kind of work was a hold: neither progress nor a problem. `holds` names them as `kind:reason` (for example `sequences:paused`).

Otherwise it is **healthy**, or **idle** if it has no scheduled work. The thresholds are constants in `lib/ops/scheduler-runs.ts`.

`GET /api/health/scheduler` answers 200 when there is no problem and 503 otherwise. It returns:
- the scheduler's own state and the last completed run's age;
- the lease generation and the error **class** of the last run;
- counts across tenants: tracked, blocked, held, reply sync stale, overdue, oldest overdue. Held tenants are a count only, never a problem.

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
| `latest scheduler run failed` / `lease_lost` | The app journal for the failed tick; `last_error_class` in the health response. `lease_lost`: another process took the tick lease mid-run (two schedulers, or a run slower than the 30 min lease). | Fix the failing step, or make sure only one scheduler calls the tick. The alert clears on the next successful run. |
| `scheduler crashed` | The app journal around `running_since`: OOM, restart or deploy. | Nothing to clean up. The next tick takes over once the lease expires (at most 30 min after the crash) at a new generation, and its run reads fresh. Unfinished sends from the dead run are handled by the claim machinery: `sending` claims older than 10 min become `uncertain` and are never resent automatically (docs/STAGING.md send-safety scenarios). Resolve those before resuming. |
| `N tenant(s) blocked` | `scheduler_progress` rows with `consecutive_failures >= 3` and their `last_error` (operator DB access only; never in alerts). | Usually a disconnected Gmail account, withdrawn reply consent, a missing sender identity, or an uncertain send waiting for the tenant. `not_available` / `sequences_disabled`: the operator switch is off (or the kill switch on) while tenants have work turned on. The tenant sees "Scheduled work is blocked" on their Outreach page. A tenant's pause does not clear this: the next successful run does. |
| `reply sync stale` | the same rows, `kind = 'reply_sync'` | Same as blocked. Gmail token refresh failing, or rate limits. |
| `due work overdue` | Is the scheduler fresh? If yes, look at the tenant's `sequences` progress: `last_outcome` and `last_hold` say whether a pause or a cap is holding it, `last_error` whether it is failing; the gates in `GET /api/outreach/sequences` say what is configured. | A configured hold (pause, uncertain send, kill switch) is expected to leave work due, so check the hold and the gates first. |

A recovered run resumes safely:
- each tick re-reads due work from the store;
- the lease generation fences a stale holder's writes;
- sends go through the same claim, uncertain and approval-hash checks as always.

## Not done here

- Installing the tick's own timer and the check timer on the host: Instinct, after the owner confirms the alert destination.
- Per-tenant progress for watches, monitors and index checks: they are recorded only in the run's totals today.
- Retention of `scheduler_progress` rows for deleted tenants: tied to #359's deletion lifecycle.
