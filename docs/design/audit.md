# Durable actor audit trail (#371)

Status: increment 1 (contract, database enforcement, member/session/recovery events, scoped search and export,
retention) and increment 2 (route-level events and refusals for credentials, billing, sends, CRM, lead state,
export and deletion) built. Time-bounded support access needs an owner decision; see the end of this note.

## Contract

`audit_events`, one row per attributable action:

| field | meaning |
|---|---|
| `tenant_id` | the workspace the action happened in. Account actions (sessions, password, email, Google link) are recorded in the account's personal workspace, whose id is the user id |
| `actor_id`, `actor_kind` | `users.id` and `user`; `service:<name>` and `service` for scheduled work; `support` reserved for time-bounded support access (increment 2) |
| `action` | `noun.verb`, e.g. `member.role_changed`, `invitation.accepted`, `session.revoked_all`, `account.password_reset` |
| `resource_type`, `resource_id` | what it acted on: member id, invitation id, session public id, account id. Never a token or its hash |
| `decision` | `allowed`, or `denied` for a policy refusal (role, last owner), recorded with `summary.reason` |
| `summary` | redacted JSON (`lib/audit.ts redact`), described below |
| `correlation_id` | the request id (`x-request-id`), linking the event to its request log |
| `at`, `seq` | time, and order within a second |

## Guarantees

- **Append-only in the database.** A trigger refuses every `UPDATE`. Another refuses every `DELETE`, except inside
  the retention purge's transaction, while its `audit_purge_gate` row exists. This holds on SQLite and on Postgres
  (translated to plpgsql). No route writes, edits or deletes events.
- **Atomic with the change.** An allowed event is written inside the transaction that makes the change, so both
  commit or neither does. A refusal is written after its transaction rolled back.
- **Redacted at the source.** Only short scalar fields survive. A field is dropped when its name suggests a
  credential or content (`secret|token|key|password|hash|salt|cookie|authorization|credential|body|text|content|
  html|message|reply|snippet`), or when its value looks like a key (`sk_…`, 32+ base64 or hex characters) or is
  longer than 120 characters. Secret values and reply bodies never enter the trail.
- **Scoped reads.** `GET /api/workspace/audit` needs admin or owner (`members`) and reads only the session's
  workspace. A `tenant_id` in the query is ignored. Filters: `action` prefix, `actor`, `before`, `limit`. `format=csv`
  downloads it, with cells guarded against formula injection.
- **Retention.** The tick purges events older than 400 days, at most 1000 per run, fenced by its lease.

## Covered in increment 1

- Members: role change, removal, leave, invitation create/revoke/accept. Refusals by role or the last-owner rule are
  included.
- Sessions: revoke one, revoke all (including on recovery), password re-authentication (success and wrong password).
- Account: password reset, email change, Google linking.

## Increment 2

- `requireUser()` adds the request id (`correlationId`) to the session user, so every event a route records links
  to its request log line (which names the route).
- `denied()` and `stale()` are async and record every refusal: `policy.denied` (with `needs` and `role`) and
  `policy.reauth_required`.
- Privileged handlers record their success with `audit()` / `audited()` (`lib/workspace-access.ts`). An event
  written at the route layer comes after the change. If writing it fails, the action is not undone; the failure is
  reported through `captureError` and never dropped silently. The changes that run inside the Db layer's
  transactions (members, sessions, recovery, Stripe plan changes) record in the same transaction.
- Covered: credential saves, removals and rotations (model key, enrichment, social, Cal.com, CRM, Gmail
  connect/callback/disconnect), settings (profile, memory, competitors, outreach), billing (checkout, portal, and the
  Stripe webhook's plan changes as `service:stripe`), sends and send settings (message approve/skip/send/retry,
  sequences, autopilot, replies/follow-ups), CRM pushes, lead state (confirm, unconfirm, quarantine, release), play
  offer, scan launch, lead export, deletions (monitor, commenter import, warm connections, warm path), and email
  change requests.
- `test/tenant-isolation-manifest.ts` names the event of every configure, billing, members, send, export and fresh
  handler (`audit`), and a test reads each handler and checks it records that event. The role sweep now asserts one
  denied event per refusal.

Not covered: sends made by the scheduled tick (sequences, follow-ups) have no human actor. They are already recorded
per message in the outreach ledger; adding them here as `service:tick` events is a follow-up.

## Support access: needs an owner decision

dazl has no support or staff identity today: nobody outside a workspace can read it, and this PR adds no way to.
A time-bounded grant could look like this:

- an owner grants N hours (at most 72) from Settings;
- every support request in that window is a `support` actor event;
- the grant ends on its own.

But that needs decisions first: who support is, how they authenticate (an internal IdP? per-person accounts?), and
what they may see (read-only?). Until those exist, there is no support access to bound.
