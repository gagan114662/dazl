#!/usr/bin/env bash
# One scheduled backup (issue #360; docs/RECOVERY.md). Run hourly by dazl-backup.timer, as the app's user.
#   1. create-backup.ts: an online, consistent snapshot of DB_PATH into BACKUP_DIR with its sidecar
#   2. restore-drill.ts on that file: it must restore faithfully (content), or the run fails. Its report goes to
#      DRILL_REPORT (default $BACKUP_DIR/drill-report.json), on failure too: backup-check.mts's drill leg reads that
#      same path, so a failing drill is named in the alert, not just a non-zero unit in the journal
#   3. offhost-copy.sh, when OFFHOST_DEST is set: the encrypted copy, read back and hash-checked
# Settings come from the environment (dazl-backup.service EnvironmentFile; no secrets needed: the off-host recipients
# are PUBLIC keys and the database is read, never written).
#   4. prune-backups.mts, ONLY when BACKUP_RETENTION=1 (the owner approves the numbers in docs/RECOVERY.md, Instinct sets
#      the flag): deletes local backups and off-host copies beyond RETAIN_* and refuses whole while the newest backup
#      or its drill is in doubt. Unset or anything else: nothing is ever deleted (backups accumulate; the disk alert is
#      the backstop). dazl-backup-check.timer alerts when backups stop or fail.
# Exit 0 = all steps passed; non-zero = the failed step (journal), and the freshness check alerts if it persists.
set -euo pipefail
: "${DB_PATH:?DB_PATH: the live database}" "${BACKUP_DIR:?BACKUP_DIR: where local backups go}" "${WEB_DIR:?WEB_DIR: the live release web/ directory}"
here=$(cd "$(dirname "$0")" && pwd)
cd "$WEB_DIR"
out=$(node --experimental-strip-types --no-warnings scripts/backup/create-backup.ts --source "$DB_PATH" --dest-dir "$BACKUP_DIR" --json)
b=$(printf '%s' "$out" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).backupPath)')
DRILL_REPORT="${DRILL_REPORT:-$BACKUP_DIR/drill-report.json}"
mkdir -p "$(dirname "$DRILL_REPORT")"
node --experimental-strip-types --no-warnings scripts/backup/restore-drill.ts --backup "$b" --report "$DRILL_REPORT" >/dev/null || { echo "run-backup: restore drill FAILED for $(basename "$b") (report $DRILL_REPORT)" >&2; exit 1; }
if [ -n "${OFFHOST_DEST:-}" ]; then bash "$here/offhost-copy.sh" "$b"; else echo "run-backup: OFFHOST_DEST not set: local backup only (not off-host)" >&2; fi
if [ "${BACKUP_RETENTION:-}" = 1 ]; then
  node --experimental-strip-types --no-warnings scripts/backup/prune-backups.mts --dir "$BACKUP_DIR" --drill-report "$DRILL_REPORT" ${OFFHOST_DEST:+--offhost "$OFFHOST_DEST"} || { echo "run-backup: retention refused or failed (backup itself is fine; see the JSON line above)" >&2; exit 1; }
fi
printf '{"level":"info","type":"backup","ok":true,"backup":"%s","offhost":%s}\n' "$(basename "$b")" "$([ -n "${OFFHOST_DEST:-}" ] && echo true || echo false)"
