# Sessions: inventory, revocation, cleanup, fresh authentication (#358)

Status: increment 1 (inventory, revoke one/all, reaper) and increment 2 (fresh authentication) built.

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

`reapSessions` is OFF by default. It runs on a scheduled tick only when `ACCOUNT_RETENTION_ENABLED=1` is explicitly configured after an approved retention policy, fenced by the tick's lease. It deletes at most 500 rows that expired or
were revoked more than 30 days ago. A working session (not revoked, not expired) never matches, and a backlog drains
over several ticks.

## Offboarding and recovery

- Removing a member from a workspace (`lib/workspace-members.ts`) ends their access to it on their next request.
  Their sessions stay valid for their own workspace, which is theirs.
- `revokeAllSessionsTx(t, userId, { reason: 'recovery' | 'offboarded' })` is the step that account recovery (#357)
  and account disabling take, inside their own transaction.

## Fresh authentication (increment 2)

`sessions.authed_at` records when this session last proved who it is (sign-in, or re-authentication). Existing
sessions count from when they were created. The handlers that change secrets, billing or members call
`stale(user)` (`lib/workspace-access.ts`). That answers `403 { error: 'reauth_required' }` once an hour
(`FRESH_AUTH_S`) has passed:

- model key (PUT/DELETE), enrichment keys, advanced/social credentials (POST/DELETE), Cal.com, CRM save/disconnect;
- Gmail connect (a browser navigation, so it redirects to `/app/settings?reauth=1` instead) and disconnect;
- billing checkout and portal;
- member role changes, removal, invitations and their revocation.

The manifest marks these handlers `fresh: true`. A static test checks that exactly those handlers call `stale(user)`,
and the role sweep runs every one as an owner whose sign-in is two hours old: all are refused and nothing changes.

Re-authenticating:
- Password accounts use `POST /api/auth/reauth { password }`. Only this session becomes fresh; a wrong password
  changes nothing. It is rate limited per account and per IP.
- Google accounts use `/api/auth/google?reauth=1`, which is a full Google sign-in. The callback revokes this
  browser's previous session for the same account (never another account's) and lands back on Settings.
  Known limit: if the browser is still signed in to Google, Google may complete this without asking for a password.
- Settings shows a "Confirm it is you" card whenever a request on the page answers `reauth_required`.
