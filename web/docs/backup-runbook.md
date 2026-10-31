# Backup and restore runbook (Next.js app SQLite)

Full-service recovery (decrypting every stored secret under the recovered key, unresolved-send inventory, the app started on the restored copy with sending disabled, measured times), targets and the host inventory: `docs/RECOVERY.md` and `scripts/backup/recovery-drill.mts`.

Scope: the web app's single SQLite database (`DB_PATH`, default `../../dazl-data/app.db`
relative to `web/`; `/var/lib/dazl-next/app.db` in DEPLOY.md's example). WAL mode, one
Node process, one writer. This is recovery-domain tooling - it is not the Postgres
migration rehearsal, and passing these drills does not prove production is recoverable.

## What is NOT covered (read this first)

A database file alone does not bring the service back. Also needed, none of them in this repo:

- **`DAZL_MASTER_KEY`** - without it every tenant's encrypted BYOK key in the DB is
  unreadable, so a perfect DB restore still loses each customer's LLM access until they
  re-enter keys. Back the master key up separately (password manager / sealed envelope),
  never next to the database backups.
- Other env secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, session-worker token).
- Caddy config (`/etc/caddy/Caddyfile`), the systemd/pm2 unit, the repo checkout.
- The session-worker stores nothing (verified: `session-worker/README.md`, `src/server.ts`),
  so it needs no backup. The legacy Cloudflare `worker/` D1 stack never ran and is out of scope.

## Current state (honest, as of 2026-10-22)

- What is verified: no backup tooling or schedule for the app DB exists in this repo
  (grep-verified). What exists on the EC2 host outside the repo - EBS/cloud snapshots,
  manual copies, anything Gagan's side already runs - is unknown and not verified here.
- So: if nothing exists outside the repo, RPO is effectively total loss on disk failure.
  RTO is unproven either way - no restore has ever been drilled on the host.
- This PR adds tooling + tests only. It changes nothing on the box. The schedule,
  off-box copy and retention policy are open decisions (see Gaps), not assignments.

## Taking a backup (safe while the app runs)

```
cd <repo>/web
node --experimental-strip-types scripts/backup/create-backup.ts --source "$DB_PATH" --dest-dir /var/backups/dazl
```

- Source resolution: `--source` > `$DB_PATH` > `../../dazl-data/app.db`; the path used is
  printed and recorded in the sidecar.
- Uses the SQLite online backup API: transactionally consistent while the in-process scan
  runner / cron keep writing (covered by an interleaved-writer test). The snapshot is the
  committed state as of the backup's read.
- Never `cp app.db backup.db` on a live database: in WAL mode the newest commits live in
  `app.db-wal`, so a raw copy of the main file is stale or torn, and copying db+wal
  together races the writer. If a raw copy is ever the only option: stop the app first
  (a clean close checkpoints the WAL), then copy.
- The script opens the source read-only, never overwrites (timestamp + random suffix,
  `.partial` then atomic rename), normalizes the result to `journal_mode=DELETE` so the
  backup is ONE self-contained file safe to rsync/archive, runs `integrity_check` on what
  it wrote, and drops a `<backup>.json` sidecar with the sha256 and byte count.
  The sidecar catches accidental modification after creation; it is NOT an authenticity
  check - anything that can rewrite the backup can rewrite the sidecar sitting next to
  it. Real integrity anchoring would store the manifest separately from the backups.
- Suggested starting schedule (operator's side): hourly cron, keep 48 hourly + 14 daily.
  Retention/pruning is deliberately NOT implemented in this PR - deleting backups is its
  own policy decision.

## Verifying a backup (restore drill)

```
node --experimental-strip-types scripts/backup/restore-drill.ts --backup /var/backups/dazl/dazl-backup-<ts>.db
# exit 0 = pass, 1 = verification failed, 2 = usage/guard refusal
```

The drill:

1. Refuses URLs, missing files, `-wal`/`-shm` sidecars, and any pre-existing work
   directory it did not create itself (marker file; there is no override).
2. Verifies the backup file against its `.json` sidecar manifest when present. SQLite
   has no content checksums, so without the manifest a byte-level edit that keeps the
   file valid is undetectable - the drill says so as a warning. The manifest proves
   accidental-change detection only, not authenticity (both files are equally mutable).
3. Restores into the throwaway dir via the backup API (proving the backup opens as a
   real database), then compares backup vs restored: `integrity_check`, schema hash,
   per-table row counts and full-content hashes.
4. Re-hashes the backup afterwards to prove the drill never modified it, and cleans up
   (`--keep-work-dir` to inspect the restored copy).
5. Reports `foreign_key_check` violations as a WARNING, not a failure: the app does not
   set `PRAGMA foreign_keys`, so a faithful backup can legitimately contain violations.

What a pass proves: this backup file is internally consistent and restores byte-faithfully.
What it does NOT prove: that the backup is recent (that is the schedule's job), that the
app comes back (env, secrets, ports), or that any backup exists at all. A backup that has
never been drilled is a rumor. Run the drill on every backup - it is milliseconds cheap.

## Actually recovering (box lost / DB corrupted)

1. Stop the app. Move the broken DB aside - do not delete it.
2. Restore the newest passing backup into place:
   `restore-drill.ts --backup <file> --keep-work-dir --work-dir <scratch>` then copy the
   verified `restored.db` to `$DB_PATH` (the app re-enables WAL on open).
3. Confirm `DAZL_MASTER_KEY` and the other env vars are the originals.
4. Start the app, `curl localhost:3100/api/ready` (200, `ok:true`), log in, open a leads page.
5. Scan jobs captured mid-`running` self-heal: the existing stale-job reaper
   (`SCAN_STALE_RUNNING_S`) flips them to pending/failed. No manual cleanup.

## Gaps / decisions still open

| item | state | consequence |
|---|---|---|
| Backup schedule on the box | open decision, not yet grounded | repo tooling sits unused until decided |
| Existing host/cloud/manual backups | unknown | ask before assuming either presence or absence |
| Off-box copy (rsync/object storage) | open decision, not yet grounded | on-box-only backups die with the box |
| Sidecar manifests stored with the backups | as shipped | tamper-evidence only; separate storage would add authenticity |
| RTO | unmeasured | no restore drill has ever run on the EC2 host |
| RPO target | open decision | hourly cron above is a suggestion, not an agreement |
| Retention/pruning | open decision (not implemented) | scheduling without a policy fills the disk |
| Large DBs | drill holds table rows in memory for hashing | fine at current scale; revisit past ~1GB |
