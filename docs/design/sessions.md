# Sessions: inventory, revocation, cleanup, fresh authentication (#358)

Status: increment 1 (inventory, revoke one/all, reaper) built; increment 2 (fresh authentication) next.

## Model

`sessions` keeps its key, the SHA-256 of the cookie token. New columns:

| column | why |
|---|---|
| `public_id` | random 96-bit id, the only handle the UI and API show (never the token or its hash) |
| `last_seen_at` | last activity, written at most once per 5 minutes per session |
| `device` | coarse label from the User-Agent ("Chrome on macOS"); the raw header is never stored |
| `revoked_at`, `revoked_by`, `revoke_reason` | who ended it, when, why (`signed_out`, `revoked`, `revoked_all`, `recovery`, `offboarded`) |

A revoked session keeps its row, so there is a record without any token in it. `getSessionUser` refuses a revoked
or expired row on the very next request, on every instance, because the check reads that row from the shared store.

## API and UI

- `GET /api/auth/sessions`: the account's own working sessions (device, signed in, last active, this one).
- `DELETE /api/auth/sessions { id }`: sign out one of the account's own sessions, by public id. Another account's
  id, a token or a hash answers 404.
- `POST /api/auth/sessions/revoke-all { keep_current }`: everywhere else (the default), or everywhere.
- Settings > Devices lists them, with "Sign out" on each row and "Sign out everywhere else".
- Sign-out now revokes rather than deletes the row.

## Cleanup

`reapSessions` runs on each scheduled tick, fenced by the tick's lease. It deletes at most 500 rows that expired or
were revoked more than 30 days ago. A working session (not revoked, not expired) never matches, and a backlog drains
over several ticks.

## Offboarding and recovery

- Removing a member from a workspace (`lib/workspace-members.ts`) ends their access to it on their next request.
  Their sessions stay valid for their own workspace, which is theirs.
- `revokeAllSessionsTx(t, userId, { reason: 'recovery' | 'offboarded' })` is the step that account recovery (#357)
  and account disabling take, inside their own transaction.

## Next: fresh authentication (increment 2)

Changing secrets (model key, connectors, CRM, Gmail), billing, and members will require a sign-in within the last
hour on this session (`sessions.authed_at`). Password accounts re-enter their password; Google accounts go through
Google again. The route answers `403 { error: 'reauth_required' }` and the UI asks for it.
