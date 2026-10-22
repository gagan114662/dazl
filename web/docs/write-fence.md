# Write fence (migration write-pause) — preparation, NOT activated

Status: implemented as `web/lib/write-fence.ts` + unit tests. **Not wired into
any route, db getter, cron, or the external worker.** Wiring and any production
use require explicit authorization.

## What it is

When fenced, `openFencedDb(path)` returns a **read-only** better-sqlite3 handle:
every write through that handle fails at the SQLite layer (`readonly database`),
reads keep working. Fence state comes from `DAZL_WRITE_FENCE=1` or the presence
of the file named by `DAZL_WRITE_FENCE_FILE` (file removal ends the fence).

## Known limitations (deliberate, documented)

- **Open-time only.** A process holding an existing write handle keeps writing.
  Fencing requires process restart. It is not a distributed lock.
- **External worker not covered.** Hermes writes to the same DB file over its
  SSH tunnel with its own handle. A migration window must pause the worker (and
  evaluate the */5 cron) as a separate, explicitly authorized step. Fencing the
  web app alone does NOT freeze the DB.
- **Rehearsal proof scope.** `scripts/pg-migrate/rehearse-full.ts` proved a
  read-only source freeze preserves copy integrity; that was the data-layer
  guard on a synthetic DB, not this app-level fence in production.

## Migration runbook (draft; every step gated on authorization)

1. Pause external worker writes (Hermes tunnel) and confirm quiet.
2. Set the fence file / env for the web app; restart web processes; verify
   writes return 503/readonly and reads serve.
3. Run the copy (rehearse-full pipeline against the real DB — separately
   authorized production rehearsal).
4. Verify counts + content equality.
5. Cut reads over (slice routes), keep fence until cutover decision.
6. Unfence (remove file) or proceed to Postgres write-path cutover (not
   designed yet).

## Rollback

Remove the fence file / unset env and restart; the app resumes writes against
SQLite. The fence changes no data.
