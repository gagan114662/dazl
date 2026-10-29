# Durable actor audit trail (#371)

Status: increment 1 built (contract, database enforcement, member/session/recovery events, scoped search and export,
retention). Increment 2 covers credentials, billing, sends, CRM, pipeline, export, deletion and route-level policy
refusals, plus time-bounded support access.

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

- Credential saves and removals (model key, connectors, CRM, Gmail), billing checkout/portal, outreach sends and
  autopilot changes, CRM pushes, pipeline stage changes, exports, deletions.
- Every `denied()` and `stale()` refusal at the route layer.
- Support access: a grant an owner approves, with an expiry, recorded as `support` actor events, after which access
  ends on its own.
