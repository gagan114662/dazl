# Durable actor audit trail (#371)

Status: contract, database enforcement, route and webhook events, the owners' and admins' view, search, export and
retention built on main. Time-bounded support access needs an owner decision; see the end of this note.

## Contract

`audit_events`, one row per attributable action (`lib/audit.ts`; SQLite in `migrateAuth`, PG `0019_audit_events.sql`):

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
  event's own write. Routes pass facts only (a vendor, an outcome, a row count, whether a reason was typed), never the
  value: secret values, sender details, typed reasons and reply bodies never enter the trail.
- **Scoped reads.** `GET /api/workspace/audit` needs admin or owner (`members`) and reads only the session's workspace;
  a tenant in the query is ignored. Filters: `action` prefix (matched literally), `actor`, `limit` (up to 1000) and
  `cursor` (the previous page's `next`: the last row's time, sequence and id, so a page ending inside one second
  neither skips nor repeats events). `format=csv` downloads every matching event (up to 100,000, flagged with
  `x-audit-truncated` beyond that), with cells guarded against formula injection, and the download is itself an
  `export.audit` event. A refused read is a `denied` `audit.read` event in the workspace that was asked for, at most
  once a minute per member. Settings shows the card to owners and admins only, so nobody else's page load asks.
- **Retention.** The tick purges events older than 400 days, at most 1000 per run, fenced by its lease.

## When an event is written

- **Stripe's plan changes** (`lib/billing/stripe.ts`: applied, reconciled, held, payment failed) are written inside
  the transaction that applies them, so the change and its event commit together or not at all. A duplicate or stale
  event changes nothing and records nothing.
- **Route actions** are written after the change succeeded (`lib/audit-route.ts`). A failed audit write does not undo
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

Not covered yet: role refusals of routes other than the audit read (`denied()`, #424) answer 403 without an event;
recording them needs `denied()` to write, which is a follow-up. Actions taken by the scheduled tick (sequences,
follow-ups) have no human actor and are already in the outreach ledger.

## Support access: needs an owner decision

dazl has no support or staff identity today: nobody outside a workspace can read it, and this change adds no way to.
A time-bounded grant could be an owner granting N hours (at most 72) from Settings, every support request in that
window recorded as a `support` actor event, and the grant ending on its own. That needs decisions first: who support
is, how they authenticate, and what they may see. Until those exist, there is no support access to bound.
