# Workspaces, memberships and roles (#353)

Status: increment 1 of 3 shipped with this note. Related: #358 (sessions/offboarding), #357 (email ownership),
#371 (audit trail), product direction #204.

## Problem

Today the tenant is the account: `requireUser()` returns a `users` row and every tenant-scoped table filters on
`tenant_id = users.id`. That isolates accounts, but a customer cannot have a second person in their workspace, and
"who did this" (actor) cannot be told apart from "whose data is this" (tenant).

## Data model

```
organizations (id PK, name, kind 'personal'|'team', created_by, created_at)
memberships   (tenant_id, member_id, role 'owner'|'admin'|'operator'|'viewer', created_at, added_by,
               PRIMARY KEY (tenant_id, member_id))
sessions      + active_tenant_id NULL      -- the workspace this session chose; NULL = default
invitations   (increment 3)
```

- **A tenant is a workspace.** Every `tenant_id` in the schema is an `organizations.id`.
- **A personal workspace's id is its founder's `users.id`.** So every `tenant_id` written before this change is already
  the right workspace id. The migration only adds rows; it never rewrites tenant data, and it cannot widen access: each
  existing account becomes the sole owner of exactly the data it already had.
- `memberships.member_id` (not `user_id`): tenant-scoped tables key on `tenant_id`; the member is an actor.
- Workspace profile (business name, what they sell, buyer profile) stays on the founder's `users` row for now. With
  ids equal, `users WHERE id = tenantId` is the workspace profile. A second, non-personal workspace (`kind = 'team'`)
  needs those columns on `organizations` first; that is out of scope until there is a product need. Teams are built by
  inviting people into an existing workspace.

## Resolution (server side, every request)

`getSessionUser(token)` returns `{ actorId, tenantId, role, id, email, business_name }`:

1. Session row (hash of the cookie token, not expired) -> the actor.
2. If the session chose a workspace (`active_tenant_id`), the membership row for (that workspace, actor) must exist.
   If it does not (member removed, workspace disabled, forged value), the request is **refused** (`null`, so 401):
   it never falls through to another workspace, because the request was meant for the chosen one. The stale choice is
   cleared, so the next request uses the default.
3. No choice: the personal workspace if the actor is still a member of it, else their oldest membership.
4. No membership at all and no `organizations` row with the actor's id: an account from before workspaces. Its
   personal workspace is created here, exactly as the backfill would. If the row exists (the founder left), nothing is
   created: a founder who left is never re-added.

The tenant never comes from the client. A switch endpoint (increment 3) will only write `active_tenant_id` after
checking the membership, and step 2 re-checks it on every request anyway, so a removed member loses access on their
next request on every instance (the check is a row in the shared store, not a cache).

## Roles

One table, `ACTIONS` in `lib/workspaces.ts`; routes call `can(role, action)`, never compare roles themselves.

| action    | lowest role | covers |
|-----------|-------------|--------|
| read      | viewer      | leads, campaigns, replies, settings status (never secret values) |
| export    | viewer      | CSV exports (viewers can already read every row) |
| operate   | operator    | launch scans, edit leads, drafts, stages, CRM pushes, monitors (spend or change work) |
| send      | operator    | outreach sends, follow-ups, autopilot (anything that reaches a third party) |
| configure | admin       | connectors, API keys, sending accounts, workspace profile |
| members   | admin       | invite/remove/change non-owner members |
| billing   | owner       | plans, checkout, billing portal |
| owners    | owner       | grant/remove owner, delete the workspace |

Member-management rules (increment 3): admins cannot touch owners; only owners grant owner; the last owner cannot be
removed or demoted, nor leave, in one transaction that counts owners (so two concurrent demotions cannot both pass).

## Migration path

- SQLite (production today): `migrateAuth()` creates the tables, adds `sessions.active_tenant_id` and runs
  `BACKFILL_SQL` in one transaction on startup. Idempotent; it keys on "no `organizations` row".
- Postgres: `0014_workspaces.sql`, same DDL and the same backfill statements (a test holds them equal).
- New accounts: password signup and Google sign-up create the account and its workspace in one transaction.
- Rollback: the old code ignores the new tables and column; nothing it reads changed.

## Increments

1. **This PR.** Tables, backfill, resolution, role table, tests. `requireUser()` gains `actorId`/`tenantId`/`role`;
   `id` is unchanged. No behaviour change: until switching exists, `tenantId === actorId` for everyone.
   Also fixes the `/app` layout gate, which tested an unawaited promise and so never redirected.
2. Route layer: every tenant-scoped call site uses `tenantId` (data) and `actorId` (who), and every mutating route
   checks `can()` (viewers cannot launch or send). Workers already carry the job's `tenant_id`; they keep doing so.
   Two-workspace tests: a viewer's launch/send are refused; foreign resources stay 404.
3. Invitations (hashed one-use expiring tokens, bound to the invited email, accepted only by a signed-in account
   with that email; email stubbed), member list/role change/removal with last-owner protection, workspace switching.
   This is the first point where `tenantId !== actorId` can happen, so it ships only after increment 2.

Then #358 (session inventory, revoke-all, revoke on removal/recovery), #357 (email verification, reset), #371
(actor audit trail, which records `actorId` and `tenantId` separately from the start).

## Not changed

Tenant scoping in SQL, encrypted credential binding (still bound to `tenant_id`, which is unchanged), approval hashes,
suppression checks and uncertain-send handling.
