#!/usr/bin/env bash
# Installs the production database backup (issue #1080): the hourly backup timer and the 15-minute backup check, wired
# to the LIVE release through /usr/local/lib/dazl-backup/prod-run.sh. Run once as root on the box (and again after a
# change to these files); it is idempotent and never touches the database, the app, Caddy or an existing env file.
#
#   sudo bash ops/backup/install-prod.sh                      # install with the production defaults below
#   sudo bash ops/backup/install-prod.sh --status             # read-only: what is installed, timers, newest backup
#   sudo bash ops/backup/install-prod.sh --uninstall          # stop and remove the units and the installed scripts
#                                                             # (keeps /etc/dazl-backup and every backup)
# Options (defaults are the production box; ops/prod/deploy-prod.sh uses the same ones):
#   --db PATH             the live database                     (/home/ubuntu/dazl-data/dazl-pr16.db)
#   --user NAME           the app user the jobs run as          (ubuntu)
#   --backup-dir DIR      local backups                         (/var/backups/dazl)
#   --offhost DEST        rclone:REMOTE:PATH or a mounted directory; with it OFFHOST_REQUIRED=1 (no fresh off-host
#                         copy = an alert). Without it backups are LOCAL ONLY and the script says so.
#   --recipients FILE     age PUBLIC keys for the off-host copy (/etc/dazl-backup/recipients.txt); required with --offhost
#   --ledger PATH         the app's DAZL_TOMBSTONE_LEDGER. Default: the value in --app-env; when the app sets none,
#                         /var/lib/dazl-ledger/tombstones.jsonl with a WARNING (the app must be given the same path).
#                         A --ledger that differs from the app's own value is refused. Created empty if absent.
#   --app-env FILE        the app's run env, read as data for DAZL_TOMBSTONE_LEDGER only (/home/ubuntu/dazl-pr16-run.env)
#   --alert-url URL       https webhook for backup alerts (OPS_ALERT_WEBHOOK_URL); without it alerts go to the journal only
#   --no-retention        leave retention OFF (BACKUP_RETENTION=0): nothing is ever deleted, and the installer prints how many
#                         days the disk lasts. Default is ON: 48 local hourly copies; off-host 48 hourly + 14 daily + 8
#                         weekly (the owner-approved numbers). The 15-minute check alerts on low space either way.
#   --keep-env            an existing /etc/dazl-backup/env that differs from the options given is kept and used as it
#                         is. Without this flag such a difference STOPS the install (exit 1, the differing settings
#                         named), so an option is never silently ignored.
#   --no-start            install and enable nothing; print what would be started (for a review on the box)
#   --root DIR            install under DIR instead of / and never call systemctl (tests)
# What it writes:
#   /usr/local/lib/dazl-backup/{prod-run.sh,live-release.sh}   root-owned copies of this checkout's files
#   /etc/systemd/system/dazl-backup{,-check}.{service,timer}   the units (User = the app user)
#   /etc/dazl-backup/env                                       ONLY when it does not exist (root:<app group>, 640); an
#                                                              existing file is kept and compared, never rewritten
#   the backup directory (app user, 700) and an empty ledger file, each ONLY when absent: an existing directory or
#   file is never re-owned or re-moded (it is checked, and a backup directory the app user cannot write is refused)
#   the ledger's append-only flag (chattr +a, #1089), on a new or an existing ledger: the app appends, nobody rewrites
# Then: systemctl daemon-reload, enable --now both timers, and one backup run right away so the first copy exists
# before this script returns (its exit code is the script's). No secrets are read or written: the off-host recipients
# are PUBLIC keys; rclone credentials stay in the app user's own rclone config (or the instance role).
set -euo pipefail
die() { echo "install-prod: $1" >&2; exit "${2:-1}"; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DB=/home/ubuntu/dazl-data/dazl-pr16.db; APP_USER=ubuntu; BACKUP_DIR=/var/backups/dazl; OFFHOST=; RECIP=/etc/dazl-backup/recipients.txt
LEDGER=; LEDGER_DEFAULT=/var/lib/dazl-ledger/tombstones.jsonl; APP_ENV=/home/ubuntu/dazl-pr16-run.env; ALERT=; ROOT=; START=1; MODE=install; KEEP_ENV=0; APP_ENV_GIVEN=0; RETENTION=1
while [ $# -gt 0 ]; do
  case "$1" in
    --db|--user|--backup-dir|--offhost|--recipients|--ledger|--app-env|--alert-url|--root)
      [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" 2
      case "$1" in --db) DB=$2 ;; --user) APP_USER=$2 ;; --backup-dir) BACKUP_DIR=$2 ;; --offhost) OFFHOST=$2 ;; --recipients) RECIP=$2 ;; --ledger) LEDGER=$2 ;; --app-env) APP_ENV=$2; APP_ENV_GIVEN=1 ;; --alert-url) ALERT=$2 ;; --root) ROOT=${2%/} ;; esac
      shift 2 ;;
    --no-start) START=0; shift ;;
    --keep-env) KEEP_ENV=1; shift ;;
    --no-retention) RETENTION=0; shift ;;
    --status) MODE=status; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    *) die "unknown option $1 (see the header of this file)" 2 ;;
  esac
done
for v in "$DB" "$BACKUP_DIR" "$RECIP" "${LEDGER:-$LEDGER_DEFAULT}" "$APP_ENV"; do [[ $v == /* && $v != *[[:space:]]* ]] || die "paths must be absolute with no spaces: '$v'" 2; done
[[ $APP_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || die "--user '$APP_USER' is not a user name" 2
[ -z "$ALERT" ] || [[ $ALERT == https://* && $ALERT != *[[:space:]]* ]] || die "--alert-url must be an https URL" 2
[ -z "$OFFHOST" ] || [[ $OFFHOST != *[[:space:]]* ]] || die "--offhost must have no spaces" 2
LIB=$ROOT/usr/local/lib/dazl-backup; UNITS=$ROOT/etc/systemd/system; ETC=$ROOT/etc/dazl-backup; ENVF=$ETC/env
NAMES=(dazl-backup.service dazl-backup.timer dazl-backup-check.service dazl-backup-check.timer)
sysctl_() { if [ -n "$ROOT" ]; then echo "(--root: not run) systemctl $*"; else systemctl "$@"; fi; }

if [ "$MODE" = status ]; then
  for f in prod-run.sh live-release.sh; do
    if [ -f "$LIB/$f" ] && [ "$(sha256sum < "$LIB/$f")" = "$(sha256sum < "$HERE/$f")" ]; then echo "$f: installed = this checkout"; else echo "$f: MISSING or DIFFERS in $LIB"; fi
  done
  for n in "${NAMES[@]}"; do if [ -f "$UNITS/$n" ]; then echo "$n: installed"; else echo "$n: MISSING"; fi; done
  if [ -f "$ENVF" ] && [ ! -r "$ENVF" ]; then echo "env: $ENVF present (not readable by $(id -un): run --status with sudo to see its settings)"
  elif [ -f "$ENVF" ]; then echo "env: $ENVF present (OFFHOST_DEST $(grep -q '^OFFHOST_DEST=.\+' "$ENVF" && echo set || echo 'NOT set: local backups only'))"; else echo "env: $ENVF MISSING"; fi
  [ -n "$ROOT" ] || systemctl list-timers --all 'dazl-backup*' --no-pager 2>/dev/null || true
  newest=$(find "$ROOT$BACKUP_DIR" -maxdepth 1 -name 'dazl-backup-*.db' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)
  if [ -n "$newest" ]; then echo "newest local backup: $(basename "$newest"), $(( $(date +%s) - $(stat -c %Y "$newest") )) s old"; else echo "newest local backup: NONE in $BACKUP_DIR"; fi
  exit 0
fi
[ -n "$ROOT" ] || [ "$(id -u)" = 0 ] || die "run as root (sudo)" 2

if [ "$MODE" = uninstall ]; then
  sysctl_ disable --now dazl-backup.timer dazl-backup-check.timer || true
  for n in "${NAMES[@]}"; do rm -f -- "${UNITS:?}/${n:?}"; done
  rm -f -- "${LIB:?}/prod-run.sh" "${LIB:?}/live-release.sh"; rmdir -- "$LIB" 2>/dev/null || true
  sysctl_ daemon-reload
  echo "install-prod: units and installed scripts removed; $ETC and every backup are kept"
  exit 0
fi

# --- checks before anything is written
if [ -z "$ROOT" ]; then
  id -u "$APP_USER" >/dev/null 2>&1 || die "no user '$APP_USER' on this host"
  [ -f "$DB" ] || die "the database $DB does not exist (give --db)"
  # node as the units will find it: the app user, systemd's default PATH (an nvm-only node would fail every run)
  sudo -u "$APP_USER" env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin sh -c 'command -v node >/dev/null' || die "node is not on the default PATH for $APP_USER (the units run /usr/bin/env node): link it into /usr/local/bin"
  if [ -n "$OFFHOST" ]; then
    command -v age >/dev/null || die "age is not installed (apt-get install -y age): needed for the encrypted off-host copy"
    case "$OFFHOST" in rclone:*) command -v rclone >/dev/null || die "rclone is not installed (apt-get install -y rclone)" ;; *) [ -d "$OFFHOST" ] || die "--offhost $OFFHOST is not a directory" ;; esac
  fi
fi
if [ -n "$OFFHOST" ]; then
  [ -s "$ROOT$RECIP" ] || die "--offhost needs the age PUBLIC keys in $RECIP (one age1... per line; the private key stays offline)"
  if grep -q 'AGE-SECRET-KEY' "$ROOT$RECIP"; then die "$RECIP holds a PRIVATE key: public keys (age1...) only"; fi
  grep -Eq '^age1[0-9a-z]+$' "$ROOT$RECIP" || die "$RECIP has no age1... public key line"
fi
# the deletion ledger must be the file the APP writes: its own DAZL_TOMBSTONE_LEDGER (read as data, never sourced)
app_ledger=
[ "$APP_ENV_GIVEN" = 0 ] || { [ -f "$APP_ENV" ] && [ -r "$APP_ENV" ]; } || die "--app-env $APP_ENV is not a readable file" 2
if [ -f "$APP_ENV" ] && [ -r "$APP_ENV" ]; then app_ledger=$(sed -n 's/^\(export[[:space:]]\+\)\?DAZL_TOMBSTONE_LEDGER=//p' "$APP_ENV" | tail -1 | sed -e "s/^['\"]//" -e "s/['\"]\$//"); fi
LEDGER_WARN=
if [ -n "$app_ledger" ]; then
  [ -z "$LEDGER" ] || [ "$LEDGER" = "$app_ledger" ] || die "--ledger $LEDGER is not the app's DAZL_TOMBSTONE_LEDGER ($app_ledger in $APP_ENV): the copy would be of a file the app never writes"
  LEDGER=$app_ledger
  [[ $LEDGER == /* && $LEDGER != *[[:space:]]* ]] || die "the app's DAZL_TOMBSTONE_LEDGER is not an absolute path with no spaces"
else
  LEDGER=${LEDGER:-$LEDGER_DEFAULT}
  LEDGER_WARN="install-prod: WARNING: $APP_ENV sets no DAZL_TOMBSTONE_LEDGER (or cannot be read): the app is not writing a deletion ledger. Add DAZL_TOMBSTONE_LEDGER=$LEDGER to it and deploy; until then the off-host ledger copy is an empty file, not proof of no deletions."
fi
for d in "$BACKUP_DIR" "$(dirname "$LEDGER")"; do d=$(realpath -m -- "$d"); case "$d" in /|/etc|/var|/var/lib|/var/backups|/home|/usr|/tmp|/root) die "refusing to use the system directory $d itself: give a directory of its own" 2 ;; esac; done
# --- space: every backup is a full copy on this disk, and a full disk stops the database
space_dir=$ROOT$BACKUP_DIR; while [ ! -d "$space_dir" ]; do space_dir=$(dirname "$space_dir"); done
free_mb=$(( $(df -Pk -- "$space_dir" | awk 'NR==2 {print $4}') / 1024 ))
db_mb=1; if [ -f "$DB" ]; then db_mb=$(( ($(stat -c %s -- "$DB") + 1048575) / 1048576 )); fi
SPACE_NOTE=
if [ "$RETENTION" = 1 ]; then
  need_mb=$(( db_mb * 48 * 2 ))   # the 48 kept copies, twice over for growth and the copy being written
  [ "$free_mb" -ge "$need_mb" ] || die "not enough room for the retained backups: $BACKUP_DIR has $free_mb MB free, 48 copies of a $db_mb MB database need $(( db_mb * 48 )) MB (want $need_mb MB free). Free space or give another --backup-dir."
  SPACE_NOTE="install-prod: retention ON: at most 48 local copies (about $(( db_mb * 48 )) MB of $free_mb MB free); off-host 48 hourly + 14 daily + 8 weekly"
else
  days=$(( free_mb / (db_mb * 24) ))
  [ "$days" -ge 7 ] || die "retention is OFF and $BACKUP_DIR would be full in about $days days ($free_mb MB free, $(( db_mb * 24 )) MB of backups a day): refusing. Install without --no-retention, or free space first."
  SPACE_NOTE="install-prod: WARNING: retention is OFF (--no-retention): nothing is ever deleted. $(( db_mb * 24 )) MB of backups a day, $free_mb MB free: the disk is FULL in about $days days. The 15-minute check alerts when under 14 days or 1024 MB remain."
fi
GROUP=$APP_USER; [ -n "$ROOT" ] || GROUP=$(id -gn "$APP_USER")
own() { [ -n "$ROOT" ] || chown "$1" "$2"; }

# --- the stable scripts
install -d -m 755 "$LIB" "$UNITS"; install -d -m 750 "$ETC"; own "root:$GROUP" "$ETC"
install -m 755 "$HERE/prod-run.sh" "$LIB/prod-run.sh"; install -m 755 "$HERE/live-release.sh" "$LIB/live-release.sh"

# --- the env file: written once; an existing one is the operator's and is never rewritten
want=$(cat <<EOF
# /etc/dazl-backup/env, written by ops/backup/install-prod.sh. No secrets belong here. See ops/backup/env.example.
DB_PATH=$DB
BACKUP_DIR=$BACKUP_DIR
OFFHOST_AGE_RECIPIENTS=$RECIP
OFFHOST_DEST=$OFFHOST
OFFHOST_REQUIRED=$([ -n "$OFFHOST" ] && echo 1 || echo 0)
DAZL_TOMBSTONE_LEDGER=$LEDGER
OPS_ALERT_WEBHOOK_URL=$ALERT
BACKUP_ALERT_EVERY_S=3600
RCLONE_TIMEOUT_S=120
BACKUP_RETENTION=$RETENTION
RETAIN_LOCAL=48
RETAIN_OFFHOST_HOURLY=48
RETAIN_OFFHOST_DAILY=14
RETAIN_OFFHOST_WEEKLY=8
CONFIG_REQUIRED=0
KEY_DRILL_REQUIRED=0
EOF
)
if [ -f "$ENVF" ]; then
  if [ "$(cat "$ENVF")" = "$want" ]; then echo "install-prod: $ENVF already has these settings"
  else
    differ=$( { diff <(grep -E '^[A-Z_]+=' "$ENVF" | sort) <(printf '%s\n' "$want" | grep -E '^[A-Z_]+=' | sort) || true; } | sed -n 's/^[<>] \([A-Z_]*\)=.*/\1/p' | sort -u | tr '\n' ' ' || true)
    have_ledger=$(sed -n 's/^DAZL_TOMBSTONE_LEDGER=//p' "$ENVF" | tail -1)
    [ -z "$app_ledger" ] || [ "$have_ledger" = "$app_ledger" ] || die "$ENVF copies the ledger '$have_ledger' but the app writes '$app_ledger' ($APP_ENV): fix DAZL_TOMBSTONE_LEDGER in $ENVF (--keep-env does not cover this)"
    [ "$KEEP_ENV" = 1 ] || die "$ENVF exists and differs from the options given in: ${differ}. Nothing was changed in it. Edit it by hand, move it away and run again, or pass --keep-env to install with the file as it is."
    echo "install-prod: $ENVF exists and is KEPT as it is (--keep-env); it differs from the options given in: ${differ}"
  fi
else
  ( umask 027; printf '%s\n' "$want" > "$ENVF.tmp" ); chmod 640 "$ENVF.tmp"; own "root:$GROUP" "$ENVF.tmp"; mv -f "$ENVF.tmp" "$ENVF"
  echo "install-prod: wrote $ENVF"
fi

# --- directories the jobs need
# created only when absent; something that already exists is the operator's: never re-owned, never re-moded
if [ ! -e "$ROOT$BACKUP_DIR" ]; then install -d -m 700 "$ROOT$BACKUP_DIR"; own "$APP_USER:$GROUP" "$ROOT$BACKUP_DIR"; echo "install-prod: created $BACKUP_DIR (700, $APP_USER)"
else
  [ -d "$ROOT$BACKUP_DIR" ] && [ ! -L "$ROOT$BACKUP_DIR" ] || die "$BACKUP_DIR exists and is not a directory"
  [ -n "$ROOT" ] || sudo -u "$APP_USER" test -w "$BACKUP_DIR" || die "$BACKUP_DIR exists but $APP_USER cannot write it (left as it is: fix its owner, or give another --backup-dir)"
  echo "install-prod: $BACKUP_DIR already exists: left as it is"
fi
if [ ! -e "$ROOT$LEDGER" ]; then
  ld=$(dirname "$ROOT$LEDGER")
  if [ ! -e "$ld" ]; then install -d -m 750 "$ld"; own "$APP_USER:$GROUP" "$ld"; fi
  install -m 600 /dev/null "$ROOT$LEDGER"; own "$APP_USER:$GROUP" "$ROOT$LEDGER"
  echo "install-prod: created the empty deletion ledger $LEDGER"
fi
# append-only (#1089): the app user owns the ledger and appends to it (lib/tenant/ledger.ts opens it with 'a'); the
# kernel's append-only flag, which only root can set or clear, refuses any rewrite, truncation, rename or delete of it,
# even by its owner. Set on a new or an existing ledger; skipped under --root (tests) and on a filesystem without it.
if [ -z "$ROOT" ]; then
  if lsattr -d -- "$LEDGER" 2>/dev/null | awk '{print $1}' | grep -q a; then echo "install-prod: the deletion ledger $LEDGER is already append-only"
  elif chattr +a -- "$LEDGER"; then echo "install-prod: set the deletion ledger $LEDGER append-only (chattr +a): the app can add lines; nobody can rewrite, truncate or delete it without root"
  else echo "install-prod: WARNING: could not set $LEDGER append-only (chattr +a failed): the app user can still rewrite or truncate it. Put the ledger on an ext4/xfs filesystem and run this again."
  fi
fi

# --- the units: same schedule as the templates in this directory, pointed at the installed entry point
unit() { printf '%s\n' "$2" > "$UNITS/$1.tmp"; chmod 644 "$UNITS/$1.tmp"; mv -f "$UNITS/$1.tmp" "$UNITS/$1"; }
unit dazl-backup.service "# Installed by ops/backup/install-prod.sh (issue #1080). Edit the repo file and run it again; do not edit here.
[Unit]
Description=dazl database backup (online snapshot, restore check, encrypted off-host copy)

[Service]
Type=oneshot
User=$APP_USER
EnvironmentFile=/etc/dazl-backup/env
ExecStart=/usr/bin/env bash /usr/local/lib/dazl-backup/prod-run.sh backup
TimeoutStartSec=20min
Nice=10
IOSchedulingClass=idle"
unit dazl-backup.timer "$(cat "$HERE/dazl-backup.timer")"
unit dazl-backup-check.service "# Installed by ops/backup/install-prod.sh (issue #1080). Edit the repo file and run it again; do not edit here.
[Unit]
Description=dazl backup freshness check

[Service]
Type=oneshot
TimeoutStartSec=5min
User=$APP_USER
EnvironmentFile=/etc/dazl-backup/env
ExecStart=/usr/bin/env bash /usr/local/lib/dazl-backup/prod-run.sh check"
unit dazl-backup-check.timer "$(cat "$HERE/dazl-backup-check.timer")"
echo "install-prod: installed ${NAMES[*]} and $LIB/{prod-run.sh,live-release.sh}"
[ -n "$OFFHOST" ] || echo "install-prod: WARNING: no --offhost destination: backups are LOCAL ONLY (same disk). The box is not protected against losing the disk until one is set."
echo "$SPACE_NOTE"
[ -z "$LEDGER_WARN" ] || echo "$LEDGER_WARN"
[ -n "$ALERT" ] || echo "install-prod: WARNING: no --alert-url: a stale or failed backup is written to the journal only."

if [ "$START" = 0 ]; then echo "install-prod: --no-start: nothing enabled. To start: systemctl daemon-reload && systemctl enable --now dazl-backup.timer dazl-backup-check.timer && systemctl start dazl-backup.service"; exit 0; fi
sysctl_ daemon-reload
sysctl_ enable --now dazl-backup.timer dazl-backup-check.timer
# the first backup now, so a copy exists before this returns; its failure is this script's failure
if sysctl_ start dazl-backup.service; then echo "install-prod: first backup run finished (journalctl -u dazl-backup -n 20)"
else [ -n "$ROOT" ] || journalctl -u dazl-backup.service -n 30 --no-pager || true; die "the first backup run FAILED (the timers stay enabled; fix the cause above and run: systemctl start dazl-backup.service)"; fi
