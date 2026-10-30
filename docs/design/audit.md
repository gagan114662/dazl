# Durable actor audit trail (#371)

Status: contract, database enforcement, route and webhook events, the owners' and admins' view, search, export and
retention built on main. Time-bounded support access needs an owner decision; see the end of this note.

## Contract

`audit_events`, one row per attributable action (`lib/audit.ts`; SQLite in `migrateAuth`, PG `0018_audit_events.sql`):

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
  (plpgsql). No route writes, edits or deletes events, so no member, viewer or otherwise, can alter history.
- **Redacted at the source.** Only short scalar fields survive. A field is dropped when its name suggests a credential
  or content (`secret|token|key|password|hash|salt|cookie|authorization|credential|body|text|content|html|message|
  reply|snippet`), when its value looks like a key (`sk_…`, 32+ base64 or hex characters), or when it is longer than
  120 characters. Routes pass facts only (a vendor, an outcome, a row count, whether a reason was typed), never the
  value: secret values, sender details, typed reasons and reply bodies never enter the trail.
- **Scoped reads.** `GET /api/workspace/audit` needs admin or owner (`members`) and reads only the session's workspace;
  a tenant in the query is ignored. Filters: `action` prefix (matched literally), `actor`, `before`, `limit` (up to
  1000). `format=csv` downloads it, with cells guarded against formula injection, and the download is itself an
  `export.audit` event. A refused read is a `denied` `audit.read` event in the workspace that was asked for.
- **Retention.** The tick purges events older than 400 days, at most 1000 per run, fenced by its lease.

## When an event is written

- **Stripe's plan changes** (`lib/billing/stripe.ts`: applied, reconciled, held, payment failed) are written inside
  the transaction that applies them, so the change and its event commit together or not at all. A duplicate or stale
  event changes nothing and records nothing.
- **Route actions** are written after the change succeeded (`lib/audit-route.ts`). A failed audit write does not undo
  the change; it is reported through `captureError`, so a gap is an alert rather than silent.
- The event's workspace is the one the route acted in. On main every route acts in the caller's own workspace
  (`user.id`); when routes move to `user.tenantId` (#424), `SessionUser` loses `id` and every `audit()` call moves with
  its route.

## Covered

| area | events |
|---|---|
| credentials | model key save/remove; enrichment key save/remove; social session save/remove; Cal.com signing secret rotation; CRM save/disconnect; Gmail connect (OAuth callback)/disconnect |
| billing and revenue | checkout started; billing portal opened; Stripe webhook plan changed, plan held, payment failed (`stripe`, `service`) |
| budget and sending | autopilot enable (with the daily cap), pause, resume, disable; message approve, skip, send (with its outcome), mark sent, retry; sender settings changed |
| CRM | lead pushed (outcome ok, failed or unknown); unknown result resolved |
| pipeline | lead quarantined (whether a reason was typed, never the reason), released, confirmed, unconfirmed |
| consent and channels | social channel notice accepted/revoked; channel on/off |
| export | lead export (rows, whether fixtures were included); audit export |
| deletion | warm connections deleted (rows); monitor deleted |
| policy | refused audit reads |

Not covered yet: refusals of other routes by role need the role checks of #424 (`denied()` records them there); actions
taken by the scheduled tick (sequences, follow-ups) have no human actor and are already in the outreach ledger.

## Support access: needs an owner decision

dazl has no support or staff identity today: nobody outside a workspace can read it, and this change adds no way to.
A time-bounded grant could be an owner granting N hours (at most 72) from Settings, every support request in that
window recorded as a `support` actor event, and the grant ending on its own. That needs decisions first: who support
is, how they authenticate, and what they may see. Until those exist, there is no support access to bound.
