# Workspaces, memberships and roles (#353)

Status: increments 1 (model, resolution), 2 (route layer) and 3 (invitations, members, switching) built. Related: #358 (sessions/offboarding), #357 (email ownership),
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
2. **Route layer.** `SessionUser` has no plain `id` any more, so the compiler finds every caller: tenant-scoped
   reads and writes use `tenantId`, and `actorId` is there for "who". Every session handler that does more than read
   calls `denied(user, action)` (`lib/workspace-access.ts`) right after the sign-in check, for the action
   `test/tenant-isolation-manifest.ts` names; a test reads each handler and holds it to that, and a runtime sweep calls
   every handler as every role that may not use it (403, nothing changed). The free trial stays the founder's own:
   another member acting in a keyless workspace gets `no_api_key`. Workers already carry each job's `tenant_id`.
3. **Invitations, members, switching** (`lib/workspace-members.ts`, `/api/workspace/*`, Settings > Team,
   `/app/join`). An invitation is a random 256-bit token, stored as its SHA-256, valid 7 days, bound to one email;
   inviting the same email again revokes the earlier link. Accepting needs the signed-in account whose email it was
   sent to, and uses the token up in the same transaction that adds the membership (an unknown, used, revoked or
   expired link all answer 410). dazl sends no email yet: the inviter gets the link once, with the token in the
   `#fragment` so it never reaches a server log. Every member change locks the workspace row first, so two owners
   demoting each other at once cannot both pass the last-owner check (tested on Postgres). Switching writes
   `active_tenant_id` only for a workspace the account belongs to, and only on its own session.
   Known limit until #357: password-account emails are unverified, so the token is the real proof; after #357,
   accepting will also require a verified email.

Then #358 (session inventory, revoke-all, revoke on removal/recovery), #357 (email verification, reset), #371
(actor audit trail, which records `actorId` and `tenantId` separately from the start).

## Not changed

Tenant scoping in SQL, encrypted credential binding (still bound to `tenant_id`, which is unchanged), approval hashes,
suppression checks and uncertain-send handling.
