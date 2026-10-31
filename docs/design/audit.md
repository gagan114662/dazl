# Durable actor audit trail (#371)

Status: contract, database enforcement, route and webhook events, the owners' and admins' view, search and export built
on main. Automatic deletion is OFF until the owner chooses a retention period (below). Time-bounded support access
needs an owner decision; see the end of this note.

## Contract

`audit_events`, one row per attributable action (`lib/audit.ts`; SQLite in `migrateAuth`, PG `0025_audit_events.sql`):

| field | meaning |
|---|---|
| `tenant_id` | the workspace the action happened in: the one the route acted in |
| `actor_id`, `actor_kind` | `users.id` and `user` for a person; `stripe` and `service` for Stripe's webhook; `support` reserved for time-bounded support access |
| `action` | `noun.verb`, e.g. `credential.saved`, `billing.plan_changed`, `export.leads`, `pipeline.quarantined`, `data.deleted` |
| `resource_type`, `resource_id` | what it acted on: a vendor, connector, lead, monitor, message or job id, or a Stripe event id. Never a key, token or secret |
| `decision` | `allowed`, or `denied` for a policy refusal |
| `summary` | redacted JSON (`lib/audit.ts redact`), described below |
| `correlation_id` | the request id (`x-request-id`), linking the event to its request log line; the Stripe event id for webhook events |
| `at`, `seq` | time, and order within a second |

## Guarantees

- **Append-only in the database.** A trigger refuses every `UPDATE`. Another refuses every `DELETE` except inside the
  retention purge's own transaction, while its `audit_purge_gate` row exists. This holds on SQLite and on Postgres
  (plpgsql), where a statement trigger also refuses `TRUNCATE`, which row triggers do not see. No route writes, edits or deletes events, so no member, viewer or otherwise, can alter history.
- **Redacted at the source.** Only short scalar fields survive. A field is dropped when its name suggests a credential
  or content (`secret|token|key|password|hash|salt|cookie|authorization|credential|body|text|content|html|message|
  reply|snippet`), when its value looks like a key (`sk_…`, 32+ base64 or hex characters), or when it is longer than
  120 characters. Fields past what the 2000-character column holds are dropped, so a large summary never fails the
  event's own write. A stored summary that does not parse is reported through `captureError` on every read of that
  row and comes back as `{}` with `summary_unreadable: true` beside it (also a CSV column), a field no route can
  write. Routes pass facts only (a vendor, an outcome, a row count, whether a reason was typed), never the
  value: secret values, sender details, typed reasons and reply bodies never enter the trail.
- **Scoped reads.** `GET /api/workspace/audit` needs admin or owner (`members`) and reads only the session's workspace;
  a tenant in the query is ignored. Filters: `action` prefix (matched literally), `actor`, `limit` (up to 1000) and
  `cursor` (the previous page's `next`: the last row's time, sequence and id, so a page ending inside one second
  neither skips nor repeats events). `format=csv` downloads every matching event (up to 100,000, flagged with
  `x-audit-truncated` beyond that; the bound is reached for real in `test/audit-routes.test.ts`), with cells guarded against formula injection, and the download is itself an
  `export.audit` event. A refused read is a `denied` `audit.read` event in the workspace that was asked for, at most
  once a minute per member. Settings shows the card to owners and admins only, so nobody else's page load asks.
- **Retention is an owner decision, and off until made.** No retention period is chosen yet, so the deployed default
  deletes nothing: the tick calls the purge only when `AUDIT_RETENTION_DAYS` is set to a whole number of days of at
  least 30 (`lib/audit.ts auditRetention`, the same rule `ACCOUNT_RETENTION_ENABLED` follows for sessions). Unset,
  empty, `off` and `0` are off; anything else (`abc`, `-5`, `1.5`, `29`, `400d`) is invalid. Off and invalid both
  purge nothing, and invalid is reported through `captureError` (`where: tick:audit-retention`) on every tick, so a
  typo is an alert, not a policy. The purge itself (`purgeAudit`) has no default period and refuses one it would not
  accept from the environment. With a valid period, each tick deletes events older than it, at most 1000 per run,
  inside the only transaction the delete trigger allows, after the tick's lease fence: a lost lease refuses the whole
  purge and leaves no gate row behind. The tick's response says which (`audit_retention`: `off`, `invalid` or the
  days; `audit_purged`). Tested through the real tick route (`test/audit-retention-tick.test.ts`), on SQLite and on
  a fresh Postgres schema: unset, off and every invalid form delete nothing; a valid period deletes only older
  events, in bounded batches, and the table is still append-only afterwards.

### What append-only does and does not hold against

The triggers hold against application code: no statement the app runs can update, delete (outside the purge's own
transaction) or truncate an event. They do not hold against the database role itself: a role that can run DDL can
drop or disable the triggers, and a committed `audit_purge_gate` row (someone with database access, or a crash in a
path that wrote the gate outside a transaction, which no code path does) silently makes `DELETE` allowed and makes
every tick's purge fail loudly on its own gate insert. Protection from the database role is an operational matter
(backups, restricted roles), not something this table can provide for itself. On the other side, the Stripe webhook
writes its events in the transaction that applies the plan change, so while `audit_events` is unavailable plan
changes are refused rather than applied unrecorded, by design. The CSV guard prefixes a cell that starts, after any
leading spaces, with `=`, `+`, `-`, `@` or `|`, or with a tab or carriage return; values in the trail are server-side
identifiers and redacted scalars today, so the guard is defence in depth.

## When an event is written

- **Stripe's plan changes** (`lib/billing/stripe.ts`: applied, reconciled, held, payment failed) are written inside
  the transaction that applies them, so the change and its event commit together or not at all. A duplicate or stale
  event changes nothing and records nothing.
- **Route actions** are written after the change succeeded (`lib/audit-route.ts`). For the on/off toggles (monitors,
  social channels) "changed" is decided in the `UPDATE` itself (`... AND enabled <> ?`), so of two interleaved toggles
  each records exactly the flip it made and the trail's last event matches the row. A failed audit write does not undo
  the change; it is reported through `captureError` (`where: audit:<action>`, tested), so a gap is an alert rather
  than silent. Whether a failed audit write should instead refuse the change is an owner decision.
- The event's workspace is the one the route acted in (`user.tenantId`, #424), its actor the account acting
  (`user.actorId`): an operator's send in someone else's workspace is recorded there, under the operator's id.

## Covered

| area | events |
|---|---|
| credentials | model key save/remove; enrichment key save/remove; social session save/remove; Cal.com signing secret rotation; CRM save/disconnect; Gmail connect (OAuth callback)/disconnect |
| billing and revenue | checkout started; billing portal opened; Stripe webhook plan changed, plan held, payment failed (`stripe`, `service`) |
| budget and sending | autopilot enable (with the daily cap), pause, resume, disable; message approve, skip, send (with its outcome), mark sent, retry; sequence approve, stop, resume, mark sent, retry; follow-ups on/off; sender settings changed |
| CRM | lead pushed (outcome ok, failed or unknown, including a push whose result could not be recorded); unknown result resolved |
| configuration | business profile, memory and competitors changed (which parts, never their text) |
| monitors | created (with its interval), paused, resumed, deleted |
| pipeline | lead quarantined (whether a reason was typed, never the reason), released, confirmed, unconfirmed |
| consent and channels | social channel notice accepted/revoked; reply-reading consent accepted/revoked; channel on/off |
| export | lead export (rows, whether fixtures were included); audit export |
| deletion | warm connections deleted (rows) |
| policy | refused audit reads |

Every route row above is tested through its real route (`test/audit-routes.test.ts`, `test/audit-coverage.test.ts`):
each test names the exact events one request adds, and fails if that route's audit call is removed. Stripe's rows are
tested through `applyStripeEvent` (`test/audit.test.ts`, both engines) and through the real webhook route
(`test/billing-events.test.ts`, both engines). A request that changes nothing (a repeat send, a disconnect with
nothing connected, a toggle to the current state, a pause, resume or disable to the current state, a consent accepted
again at the current version, follow-ups turned on again, a release of a lead that is not quarantined, a revoke with
nothing on record, a no-op stop or resume) records nothing, and so does a refused or failed request (a key that is
not a key, a bad website, invalid memory, a monitor interval under the plan's minimum, a delete of an unknown id, a
checkout while already on Pro): each has a route-level negative.

## Open decisions (not built in this PR)

- **A failed audit write does not refuse the change.** It is reported through `captureError` (tested). Making
  sensitive actions fail closed (write the event in the change's own transaction and refuse when it fails) is an
  owner decision; it is a behaviour change for every audited route.
- **Refusals other than the audit read leave no event.** Role refusals (`denied()`, 403) and policy refusals of a
  send or approve (suppressed address, held lead, uncertain-send gate) answer as before, without a `denied` event.
- **Member, role, invitation and session actions** (#437, #358, now on main) are not recorded yet: this PR keeps to
  the action list above; wiring the Team and Devices routes is the next increment of #371.
- **The retention period itself.** Nothing is deleted until the owner chooses one and sets `AUDIT_RETENTION_DAYS`
  explicitly; the 30-day floor and the 1000-per-tick batch are the only bounds built in.
- **Time-bounded support access** is not built (below), so this PR is part of #371, not its close.

## Support access: needs an owner decision

dazl has no support or staff identity today: nobody outside a workspace can read it, and this change adds no way to.
A time-bounded grant could be an owner granting N hours (at most 72) from Settings, every support request in that
window recorded as a `support` actor event, and the grant ending on its own. That needs decisions first: who support
is, how they authenticate, and what they may see. Until those exist, there is no support access to bound.
