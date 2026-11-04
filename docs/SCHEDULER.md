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
- **`scheduler_progress`, one row per tenant and kind of work** (`reply_sync`, `followups`, `sequences`). Records the last attempt, last success, last failure reason, consecutive failures, and the outcome of the last attempt (`last_outcome`: `success`, `hold` or `failure`) with the hold's reason (`last_hold`).
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
| `runSequences` | `sequences_disabled` (operator switch off or kill switch, while the tenant has approved or active sequences), `reading_not_enabled`, `reply_sync_failed` | failure |
| `syncReplies` | `error` (`gmail_unavailable`, `reply_sync_failed`, `reply_sync_incomplete`) | failure; follow-ups are not attempted that tick |
| `syncReplies` | no error, but a thread in scope never read yet (`neverRead`) | hold `reply_sync_partial` (#355); with every thread read at least once it is a success as of the oldest read |
| `syncReplies` | `error` = `reading_not_enabled` | hold: the tenant's own consent/mailbox state, never a provider call that failed. Active work blocked by it fails under `followups`/`sequences` (their selectors pick tenants with work), so an idle tenant does not count as failing |
| any | a thrown error, or a `stopped` reason the tick does not know | failure (an unknown refusal is never read as progress) |

An operator switch that is off while tenants have work is deliberate, and still a failure here: the tick is running and refusing the work, and the alert after three ticks is the reminder. A tenant's own pause, cap or withdrawn consent is a hold: it is not progress, but nothing is failing. A hold after failures means the tenant is not currently failing - the state shows held, not blocked - but it does not resolve the failures either: the count stands, a failure after the hold re-blocks immediately, and only a success clears the count.

A run is `partial` when some work failed; holds alone leave it `ok`. The tick's response carries `tenant_failures` and `tenant_holds`.

## Bounded, checkpointed reply reading (#355)

`syncReplies` no longer re-reads a tenant's whole 120-day sent history on every call, so one tenant with a long history cannot hold the serial tick before the next tenant's reply checks:

- **Due threads** are read on every call, first, whatever their age: the step-1 message of an approved or active sequence, and every thread with a lead reply that follow-ups may answer (`followup_threads`, not stopped). If the time budget runs out before all of them are read, the call fails closed (`reply_sync_incomplete`): a failure, so the tick sends nothing for that tenant.
- **Background threads** are the other messages sent in the last 120 days. At most `REPLY_SYNC_MAX_THREADS` of them are read per call (default 50, from 1 to 1000), never-read ones first and then the oldest check, so each is read within `ceil(n / cap)` calls.
- **Time budget.** A call stops after `REPLY_SYNC_BUDGET_MS` (default 120000, from 1000 to 600000). A malformed or out-of-range value means the default, never an unbounded or zero limit.
- **Checkpoint.** `outreach_messages.reply_checked_at` is stamped only after a thread was read and processed without error. A failed read keeps its old stamp, so it is first in line next time.
- **Freshness.** While some thread in scope has never been read, the outcome is a hold (`reply_sync_partial`). Otherwise it is a success **as of the oldest thread read** (`freshAsOf`), which `recordProgress` stores as `last_success_at`. So `replySafetyStale` (2 h) and `reply sync stale` keep their old meaning: every thread was read within the window. A partial read is never recorded as "now".
- **Sizing.** With 5-minute ticks and a cap of 50, a tenant gets up to 600 background threads read per hour. Above about 1200 background threads, its sends to recipients it has already contacted hold, and the alerts say `reply sync stale`, until `REPLY_SYNC_MAX_THREADS` is raised. This is the honest state; such a tenant is not starved silently.

## Scans on durable workers, fair across tenants (#355)

With `DAZL_SCAN_SHARED_QUEUE=1` (default OFF; switching it on is a deploy-time step, `docs/PLATFORM.md`) scans are claimed through the shared work queue (`work_queue`, `lib/queue/scan-claimer.ts`). Off, nothing below applies and the tick kicks the runner only when watches or monitors queued scans. With it on:

- **The tick kicks the scan runner every time**, after its response, outside its lease. A scan whose worker died (lease expired) or whose retry backoff has passed is claimed again within one tick.
- **Fair service.** Claims go round-robin across tenants, and one tenant has at most `SCAN_PER_TENANT_MAX` scans claimed at once (default 1). A tenant with a long backlog or a provider that never answers holds one run slot; every other tenant's scan takes the next free one. Reply checks do not wait for scans at all: they run in the tick's own loop, while scans run in the runner's slots.
- **Proof.** `test/tenant-load-tick.test.ts` runs the real tick route and the real runner: tenant A with a 300-thread history on a slow Gmail and 40 queued scans on a provider that never answers, tenants B and C with one of each. One tick reads B's and C's threads (B's opt-out applied) and runs their scans to done while A holds one slot; the next tick does it again. With the flag unset (the control), the tick kicks no scan, and the next status-poll kick goes to the in-process claimer: A takes every slot and B's and C's scans wait.

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
- **blocked** when one kind of work has failed `BLOCKED_AFTER_FAILURES` = 3 times in a row and the last attempt is still failing;
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
| `N tenant(s) blocked` | `scheduler_progress` rows with `consecutive_failures >= 3` and their `last_error` (operator DB access only; never in alerts). | Usually a disconnected Gmail account, withdrawn reply consent, a missing sender identity, or an uncertain send waiting for the tenant. `not_available` / `sequences_disabled`: the operator switch is off (or the kill switch on) while tenants have work turned on. The tenant sees "Scheduled work is blocked" on their Outreach page. A tenant's pause or hold does not clear the count and does not keep the tenant blocked while holding: the next successful run clears it, and a resumed failure re-blocks at once. |
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
