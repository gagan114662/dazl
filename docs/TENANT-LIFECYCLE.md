# Tenant data export, deletion and retention (issue #359)

**Status:** the library and its tests (`lib/tenant/lifecycle.ts`, `lib/db/tenant-guard.ts`). No tenant has been exported or deleted anywhere, and no retention policy is decided here: every retention is an explicit argument, and the decisions are listed at the end for the owner.

**Requests (part 2, `lib/tenant/requests.ts`).** Settings > Your data:
- **Download my data:** the account's own export (`exportTenant`: every tenant-scoped table, secrets redacted, session tokens left out), as a JSON download. Each download is recorded (`tenant_requests`, kind `export`). Three an hour.
- **Ask to delete my account:** the person types `delete my account` and their account email, and their password when the account has one (a Google-only account has none; fresh re-authentication is #358/#445). This **records a request only**: no tombstone, no revoked session, no changed row. One pending request at a time, and the person can withdraw it. Shared workspaces are refused, as `deleteTenant` would refuse them (decision 9).
- **Operator:** `scripts/tenant-requests.mts list | execute | refuse`. `execute` needs the request id, the operator's name and an explicit policy file, and prints a dry run (row counts per table) unless `--confirm` is given. Confirmed, it runs `deleteTenant` with `requested_by` naming the request and the operator. That tombstone is the lasting record; the request rows themselves are the tenant's data and go with it unless the policy retains `tenant_requests`.
- Still open: who may carry out deletions and how fast (decision 7); this increment lets only an operator do it. There is no completion notice to the person, because their account and email address are gone when it completes.

## Scope: what "a tenant's data" is

Every table that `lib/tenant/scope.ts` classifies as tenant-scoped:
- tables with their own `tenant_id` or `user_id`;
- tables reached through a parent chain, for example `lead_sources` → `leads` → `scan_jobs.user_id`;
- the tenant's `users` row.

`test/tenant-isolation-db.test.ts` holds the live schema to that registry on both engines, so a new table cannot ship unclassified, and so cannot be missed by export or deletion. Global tables hold no tenant content: Stripe event ids, rate-limit counters, leases, scheduler run totals, the tombstones themselves.

## Export (`exportTenant`)

The export contains every row the tenant owns, table by table, as JSON, plus their `users` row.
- **Left out:** `sessions` and `oauth_states` (token material).
- **Redacted:** stored credentials (`ciphertext`, `refresh_ct`), `password_hash` and `salt`, which are listed in `redacted_columns`.
- **Proved in the tests:** the export of one tenant contains every table seeded for it and nothing of the other tenant.

## Deletion (`deleteTenant`): a resumable state machine

Each step is one transaction and moves the tombstone (`tenant_tombstones`) to the next state.

| state | done in that step |
|---|---|
| `requested` | the tombstone is written; from here **no write can add rows** for the tenant (guard, below) |
| `revoked` | credentials and sign-in state deleted: sessions, OAuth identities and states, Gmail tokens, LLM keys, connector secrets |
| `cancelled` | queued work deleted (`work_queue`), and the ids of every parent row (scan jobs, leads, batches, monitors, watches) recorded in `tenant_tombstone_keys` |
| `erased` | every tenant-scoped row deleted, children first, except retained tables; unexpired evidence copies are deleted under the tenant's purge gate |
| `completed` | retained tables and their row counts written to the tombstone |

- A failed step rolls back as a whole and leaves the state at the last completed step. Calling `deleteTenant` again resumes from there with the stored policy.
- Re-running a completed deletion changes nothing.
- `until` stops after a given state, for staged deletion.
- **Retention closure.** A retained table must be able to survive the deletion. Before writing the tombstone or deleting anything, deletion refuses a policy that cannot be honoured as written, and changes nothing. Refused:
  - a parent-scoped table kept without its parent (`lead_sources` without `leads`, `leads` without `scan_jobs`): deleting the parent removes its rows;
  - a table with a foreign key whose `ON DELETE` (`CASCADE`, `SET NULL`, `SET DEFAULT`) fires from a deleted table (`commenter_batches.job_id` → `scan_jobs ON DELETE SET NULL`): it would rewrite the retained rows;
  - anything that depends on a credential table, `users` or `organizations`, which are always deleted.

  The retention is never silently widened. Keeping a parent while its children go is allowed. Retained rows are left byte-identical.
- The tombstone holds the tenant id, who asked, when, the policy and what was retained. It holds no tenant content.

**Recreation guard.** A `BEFORE INSERT` trigger on every tenant-scoped table (SQLite at startup; Postgres migration `0019`) refuses a row for a tombstoned tenant, or under one of its deleted parent rows. A scan still running when the deletion starts, a late scheduler tick or a stale request therefore cannot bring erased data back. A late `UPDATE` matches no rows. Retained tables are guarded too: nothing new is added for a deleted tenant.

**Restored backups.**
- A restore brings back rows deleted after the backup and loses tombstones written since.
- `tombstoneLedgerEntry` is one JSON line per deletion (tenant id, time, who, policy; no data). It is kept **off the database**, next to the backup manifests (`docs/RECOVERY.md`).
- `reapplyTombstones` runs every ledgered deletion on a restored store. Run it **before the restored store serves traffic**: add it to the recovery plan's step 5, after the drill and before sending is re-enabled.

**Outside the database (operator steps, not automated):**
- revoking the Gmail grant at Google;
- deleting or retaining the customer at Stripe;
- the encrypted off-host backup copies, which expire with backup retention.

## Proved in `test/tenant-lifecycle.test.ts` (synthetic, SQLite)

The fixture is two tenants with a marked row in **every** tenant-scoped table (75 tables each since inbox_thread_reads and tenant_spend_pools; `test/helpers/tenant-seed-sqlite.ts`, which fails on any table it cannot fill).
- **Export:** complete for the target; nothing of the other tenant; no secret.
- **Deletion:**
  - every table is empty for the target, checked by ownership and by scanning every table for the target's marker, so orphans are caught;
  - the other tenant's snapshot is byte-identical before and after;
  - deletion refuses to run without a decision on opt-outs, refuses to retain a credential table, and refuses an unknown table.
- **No recreation:** an in-flight scan finishing after deletion adds no lead. Inserts for the tenant, under its deleted scan, a new suppression, or the same user id are all refused. The other tenant can still write.
- **Retryable:** staged to `revoked` (credentials gone, data still there), a failure injected into the erase step rolls the step back (state stays `cancelled`), and the resume completes.
- **Restored backup:** a backup taken before deletion is restored, the deletion is re-applied from the ledger line, the target's data is gone again, and the other tenant is untouched.
- **Mutations** (each made in the real module, then reverted):

  | mutation | result |
  |---|---|
  | guard triggers removed | 2 tests fail |
  | parent keys not recorded | 1 test fails |
  | a directly scoped table skipped in the erase | 4 tests fail |
  | a parent-scoped table skipped | correctly harmless: every parent-scoped table cascades from its parent |

## Policy decisions for the owner (none decided here)

1. **Opt-outs on deletion.** Keep the tenant's suppression list (`retain`), so the addresses are never mailed again if the account is restored or recreated, or erase it with everything else? If kept, keep the plain address or only a hash, and for how long? The tests run both. `deleteTenant` refuses until one is chosen.
2. **Billing and tax records** (`tenant_plans`, `stripe_ended_subscriptions`, `trial_reservations`): keep for accounting, and for how long, or erase? Stripe itself keeps its own records. Deleting the Stripe customer is a separate decision.
3. **Evidence purge audit** (`evidence_purge_audit`): append-only by design and always kept, as it holds who, why and counts with no tenant content. Confirm.
4. **Consent records** (`consent_ledger`, `mail_read_consent`, `advanced_consent`): erase with the tenant, or keep as proof of consent for a period?
5. **Grace period.** Erase immediately on request, or hold for N days (with sign-in disabled) before the `erased` step? `until: 'revoked'` already supports the hold.
6. **Backups.** How long a deleted tenant's data may remain in backups. This equals the backup retention in docs/RECOVERY.md, and the tombstone ledger must be kept at least that long.
7. **Who may delete.** Tenant self-service, operator only, or both with confirmation. Also how the export is delivered and how long the download link lives.
8. **Remote revocation.** Whether the deletion must also revoke the Gmail grant at Google and delete the Stripe customer automatically. Both are network calls outside this library.
9. **Shared workspaces** (workspaces, #353). A tenant is a workspace, and a personal workspace's id is its founder's account. Deletion today removes the workspace, its memberships and the founder's account, and **refuses** three cases: a team workspace, a workspace with other members, and a founder who also belongs to another workspace. Decide what deleting those means: remove the workspace but keep the person, delete the person everywhere, or move the profile off the account first.
