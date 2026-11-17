#!/usr/bin/env bash
# The stable entry point of the production backup units (issue #1080). install-prod.sh copies this file and
# live-release.sh to /usr/local/lib/dazl-backup/; the systemd units run the installed copy, so a unit never names a
# release directory (every deploy creates a new one and prunes old ones).
#   prod-run.sh backup   the hourly backup: the LIVE release's own ops/backup/run-backup.sh, with WEB_DIR set to it
#   prod-run.sh check    the freshness check: the LIVE release's scripts/backup/backup-check.mts
# Settings come from /etc/dazl-backup/env (the unit's EnvironmentFile). WEB_DIR there is ignored: it is always the live
# release. Runs as the app user; reads the database, never writes it. Exit: the job's own exit code; 1 when the live
# release cannot be told (live-release.sh says why).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
job=${1:-}
case "$job" in backup|check) ;; *) echo "usage: prod-run.sh backup|check" >&2; exit 2 ;; esac
release=$(bash "$here/live-release.sh")
export WEB_DIR=$release/web
: "${BACKUP_DIR:?BACKUP_DIR: where local backups go (/etc/dazl-backup/env)}"
if [ "$job" = backup ]; then
  exec bash "$release/ops/backup/run-backup.sh"
fi
cd "$WEB_DIR"
exec node --experimental-strip-types --no-warnings scripts/backup/backup-check.mts --dir "$BACKUP_DIR" --max-age-s "${BACKUP_MAX_AGE_S:-7200}" --drill-max-age-s "${DRILL_MAX_AGE_S:-7200}"
