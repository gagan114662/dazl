#!/usr/bin/env bash
# Step 2 of 2 of the off-host production backup (issue #1080; ops/backup/README.md). Run on the production box, as
# root, after ops/backup/aws-setup.sh (step 1, on the owner's machine) and after the release with this file is live.
#
#   sudo bash ops/backup/install-prod-offhost.sh --credentials /home/ubuntu/dazl-backup.s3.env --dry-run   # what it would do
#   sudo bash ops/backup/install-prod-offhost.sh --credentials /home/ubuntu/dazl-backup.s3.env
#
# --credentials FILE is the one file aws-setup.sh wrote (<bucket>.s3.env), copied here with scp: the upload-only access
# key, the bucket, region and prefix, and the age PUBLIC key. It is read as data, never executed, and the secret in it
# is never printed, never put on a command line and never written anywhere but /etc/dazl-backup/s3.env.
# What it does, in order (each step is skipped when it is already so; run it again any time):
#   1. checks: root, the live release has the S3 uploader, the file is complete and private, node and python3 exist;
#      installs `age` with apt-get when it is missing
#   2. /etc/dazl-backup/s3.env (root:<app group>, 640): the three AWS_ lines the backup units read
#   3. /etc/dazl-backup/recipients.txt: the age PUBLIC key. An existing file with another key is refused, never changed
#   4. ops/backup/install-prod.sh --offhost s3:<bucket>/<prefix>: the hourly backup timer, the 15-minute check timer,
#      /etc/dazl-backup/env, and ONE BACKUP RIGHT NOW (snapshot, restore check, encrypted upload)
#   5. the freshness check, run the way the timer runs it: the newest object in the bucket is minutes old
#   6. a restore test: the snapshot that was just uploaded is restored into a temporary file and must pass
#      PRAGMA integrity_check with every table matching. The temporary copy is removed.
# It prints PASS or FAIL for the backup, the freshness check and the restore test, and exits 0 only when all three pass.
# What it cannot test here, by design: decrypting the copy that is in the bucket. The private key is not on this box and
# this box's key cannot read the bucket. That proof is ops/backup/restore-s3.sh on the owner's machine (README, step 3).
# Options:
#   --credentials FILE   required (see above). Delete the copied file afterwards: the script reminds you
#   --dry-run            print every step and command; change nothing, install nothing, upload nothing
#   --user NAME          the app user (ubuntu)            --db PATH   the live database (install-prod.sh's default)
#   --app-env FILE       the app's run env, read as data for DAZL_TOMBSTONE_LEDGER and OPS_ALERT_WEBHOOK_URL
#                        (default: /home/ubuntu/dazl-pr16-run.env, else /etc/dazl-ops/prod.env)
#   --backup-dir DIR     local backups (/var/backups/dazl)      --recipients FILE   (/etc/dazl-backup/recipients.txt)
#   --root DIR           tests: install under DIR, never call systemctl or apt-get, run the jobs directly
# Exit: 0 all PASS; 1 a step failed or was refused (named); 2 usage.
set -euo pipefail
die() { echo "install-prod-offhost: $1" >&2; exit "${2:-1}"; }
say() { echo "install-prod-offhost: $1"; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CRED=; DRY=0; ROOT=; APP_USER=ubuntu; DB=; APP_ENV=; BACKUP_DIR=/var/backups/dazl; RECIP=/etc/dazl-backup/recipients.txt
while [ $# -gt 0 ]; do
  case "$1" in
    --credentials|--user|--db|--app-env|--backup-dir|--recipients|--root) [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" 2
      case "$1" in --credentials) CRED=$2 ;; --user) APP_USER=$2 ;; --db) DB=$2 ;; --app-env) APP_ENV=$2 ;; --backup-dir) BACKUP_DIR=$2 ;; --recipients) RECIP=$2 ;; --root) ROOT=${2%/} ;; esac; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" 2 ;;
  esac
done
[ -n "$CRED" ] || die "usage: install-prod-offhost.sh --credentials FILE [--dry-run]   (FILE is <bucket>.s3.env from aws-setup.sh)" 2
[ -f "$CRED" ] && [ -r "$CRED" ] || die "--credentials $CRED is not a readable file" 2
[[ $APP_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || die "--user '$APP_USER' is not a user name" 2
command -v python3 >/dev/null || die "python3 is not installed" 2
ETC=$ROOT/etc/dazl-backup; LIB=$ROOT/usr/local/lib/dazl-backup
perm() { stat -c %a -- "$1" 2>/dev/null || stat -f %Lp -- "$1"; }
[ "$(( 0$(perm "$CRED") & 077 ))" = 0 ] || die "--credentials $CRED can be read by other users: chmod 600 it (it holds a secret)" 2

# ---- the credentials file, as data. field NAME prints one value; the secret is only ever read by step 2's writer.
field() { python3 - "$CRED" "$1" <<'PY'
import sys
want, out = sys.argv[2], ''
for line in open(sys.argv[1]):
    line = line.strip()
    if line.startswith(want + '='): out = line.split('=', 1)[1].strip().strip('"').strip("'")
print(out)
PY
}
KEY_ID=$(field AWS_ACCESS_KEY_ID); REGION=$(field AWS_REGION); BUCKET=$(field DAZL_BACKUP_BUCKET); PREFIX=$(field DAZL_BACKUP_PREFIX); RECIPIENT=$(field DAZL_BACKUP_AGE_RECIPIENT)
[[ $KEY_ID =~ ^[A-Z0-9]{16,128}$ ]] || die "$CRED has no AWS_ACCESS_KEY_ID line: is it the file aws-setup.sh wrote?"
[ "$(field AWS_SECRET_ACCESS_KEY | wc -c)" -ge 20 ] || die "$CRED has no AWS_SECRET_ACCESS_KEY line"
[[ $REGION =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "$CRED has no valid AWS_REGION line"
[[ $BUCKET =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || die "$CRED has no valid DAZL_BACKUP_BUCKET line"
[[ $PREFIX =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "$CRED has no valid DAZL_BACKUP_PREFIX line"
[[ $RECIPIENT =~ ^age1[0-9a-z]+$ ]] || die "$CRED has no DAZL_BACKUP_AGE_RECIPIENT line (an age1... PUBLIC key)"
DEST=s3:$BUCKET/$PREFIX

# the app's run env (data only): where the deletion ledger is, and where alerts go
if [ -z "$APP_ENV" ]; then for f in /home/ubuntu/dazl-pr16-run.env /etc/dazl-ops/prod.env; do if [ -r "$f" ]; then APP_ENV=$f; break; fi; done; fi
[ -z "$APP_ENV" ] || [ -r "$APP_ENV" ] || die "--app-env $APP_ENV is not a readable file" 2
ALERT=
if [ -n "$APP_ENV" ]; then ALERT=$(sed -n 's/^\(export[[:space:]]\{1,\}\)\{0,1\}OPS_ALERT_WEBHOOK_URL=//p' "$APP_ENV" | tail -1 | sed -e "s/^['\"]//" -e "s/['\"]\$//"); fi
[[ $ALERT == https://* && $ALERT != *[[:space:]]* ]] || ALERT=

INSTALL_ARGS=(--offhost "$DEST" --user "$APP_USER" --backup-dir "$BACKUP_DIR" --recipients "$RECIP")
[ -z "$DB" ] || INSTALL_ARGS+=(--db "$DB")
[ -z "$APP_ENV" ] || INSTALL_ARGS+=(--app-env "$APP_ENV")
[ -z "$ROOT" ] || INSTALL_ARGS+=(--root "$ROOT")

say "bucket $BUCKET ($REGION), prefix $PREFIX, access key $KEY_ID (upload-only), app user $APP_USER"
say "alerts: $([ -n "$ALERT" ] && echo "the OPS_ALERT_WEBHOOK_URL of $APP_ENV (not shown)" || echo 'NO alert destination found: a stale backup will be in the journal only')"

if [ "$DRY" = 1 ]; then
  say "DRY RUN: nothing is installed, written, started or uploaded. A real run does this, in order:"
  cat <<EOF
  1. check that the live release (ops/backup/live-release.sh) has web/scripts/backup/s3.mts; apt-get install -y age (only if age is missing)
  2. write $ETC/s3.env (root:$APP_USER, 640): AWS_ACCESS_KEY_ID=$KEY_ID, AWS_SECRET_ACCESS_KEY=<from $CRED, not shown>, AWS_REGION=$REGION
  3. write $ROOT$RECIP: $RECIPIENT   (refused if that file exists with another key)
  4. bash $HERE/install-prod.sh ${INSTALL_ARGS[*]}
       -> /etc/dazl-backup/env with OFFHOST_DEST=$DEST, OFFHOST_REQUIRED=1
       -> systemctl enable --now dazl-backup.timer (hourly) dazl-backup-check.timer (every 15 minutes)
       -> systemctl start dazl-backup.service   (one backup now: snapshot, restore check, encrypted upload)
  5. the freshness check: /usr/local/lib/dazl-backup/prod-run.sh check, as $APP_USER -> PASS when the newest object in $DEST is under 2 hours old
  6. the restore test: scripts/backup/restore-drill.ts on the snapshot just uploaded, into a temporary file -> PASS when integrity_check is ok
EOF
  exit 0
fi
[ -n "$ROOT" ] || [ "$(id -u)" = 0 ] || die "run as root (sudo)" 2

# ---- 1. checks
RELEASE=$(bash "$HERE/live-release.sh") || die "cannot tell which release is live (see the line above): nothing was changed"
[ -f "$RELEASE/web/scripts/backup/s3.mts" ] || die "the live release $RELEASE has no web/scripts/backup/s3.mts: deploy the release that contains this change to production first. Nothing was changed."
if ! command -v age >/dev/null; then
  [ -z "$ROOT" ] || die "age is not installed"
  say "1. installing age (apt-get install -y age)"
  { apt-get update -q >/dev/null 2>&1 || true; DEBIAN_FRONTEND=noninteractive apt-get install -y -q age >/dev/null; } || die "apt-get install -y age failed: install age by hand and run this again. Nothing else was changed."
fi
GROUP=$APP_USER; [ -n "$ROOT" ] || GROUP=$(id -gn "$APP_USER")
say "1. checks passed: live release $(basename "$RELEASE") has the S3 uploader; age $(age --version 2>/dev/null | head -1)"

# ---- 2. the key file the units read
install -d -m 750 "$ETC"; [ -n "$ROOT" ] || chown "root:$GROUP" "$ETC"
( umask 077; python3 - "$CRED" "$ETC/s3.env.tmp" <<'PY'
import os, sys
vals = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1); vals[k.strip()] = v.strip().strip('"').strip("'")
body = ('# SECRET. The upload-only S3 key of the production backup (issue #1080). Written by ops/backup/install-prod-offhost.sh\n'
        '# from the file ops/backup/aws-setup.sh made. It can add and list backup copies; it cannot read or delete one.\n'
        + ''.join(f'{k}={vals[k]}\n' for k in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION')))
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as h: h.write(body)
PY
)
if [ -f "$ETC/s3.env" ] && cmp -s "$ETC/s3.env" "$ETC/s3.env.tmp"; then rm -f "$ETC/s3.env.tmp"; say "2. $ETC/s3.env already holds access key $KEY_ID: unchanged"
else
  [ ! -f "$ETC/s3.env" ] || say "2. $ETC/s3.env held another key or region: replaced"
  chmod 640 "$ETC/s3.env.tmp"; [ -n "$ROOT" ] || chown "root:$GROUP" "$ETC/s3.env.tmp"; mv -f "$ETC/s3.env.tmp" "$ETC/s3.env"
  say "2. wrote $ETC/s3.env (root:$GROUP, 640) with access key $KEY_ID; the secret was not shown"
fi

# ---- 3. the public key the copies are encrypted to
RECIP_FILE=$ROOT$RECIP; mkdir -p "$(dirname "$RECIP_FILE")"
if [ -s "$RECIP_FILE" ]; then
  grep -qxF "$RECIPIENT" "$RECIP_FILE" || die "$RECIP_FILE already exists and does not hold the public key in $CRED: refusing to change who can decrypt the backups. If the old key is retired, move that file away and run this again."
  say "3. $RECIP_FILE already holds this public key: unchanged"
else
  printf '%s\n' "$RECIPIENT" > "$RECIP_FILE"; chmod 644 "$RECIP_FILE"
  say "3. wrote $RECIP_FILE (a PUBLIC key: this box can encrypt backups and cannot decrypt them)"
fi

# ---- 4. timers, env file and the first backup
results=()
# job NAME: the installed entry point with the env the unit gives it (both EnvironmentFiles, read as data), as the app
# user. Under --root (tests) the stand-in settings LIVE_* and S3_ENDPOINT are passed through; on the box nothing is.
job() {
  local runner=(python3 - "$([ -n "$ROOT" ] && echo test-root || echo box)" "$ETC/env" "$ETC/s3.env" bash "$LIB/prod-run.sh" "$1")
  [ -n "$ROOT" ] || runner=(sudo -u "$APP_USER" "${runner[@]}")
  "${runner[@]}" <<'PY'
import os, sys
keep = ('PATH', 'HOME', 'LANG') + (('S3_ENDPOINT', 'LIVE_CADDYFILE', 'LIVE_CADDY_SITE', 'LIVE_PORTCONF_DIR') if sys.argv[1] == 'test-root' else ())
env = {k: v for k, v in os.environ.items() if k in keep}
for f in sys.argv[2:4]:
    for line in open(f):
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1); env[k.strip()] = v.strip()
os.execvpe(sys.argv[4], sys.argv[4:], env)
PY
}
if DAZL_BACKUP_ALERT_URL=$ALERT bash "$HERE/install-prod.sh" "${INSTALL_ARGS[@]}"; then
  if [ -n "$ROOT" ]; then   # tests: no systemd, so the first backup is run here, the way the unit would
    if job backup; then results+=("PASS  backup now"); else results+=("FAIL  backup now"); fi
  else results+=("PASS  backup now (timers installed; dazl-backup.service ran once)"); fi
else
  results+=("FAIL  backup now (install-prod.sh stopped: see its message above)")
fi

# ---- 5. the freshness check, as the 15-minute timer runs it
newest_local=; newest_remote=
if [[ ${results[0]} == PASS* ]]; then
  check_out=$(job check 2>&1) && check_rc=0 || check_rc=$?
  line=$(printf '%s\n' "$check_out" | grep '"type":"backup_check"' | tail -1 || true)
  read -r ok age newest_remote newest_local < <(printf '%s' "$line" | python3 -c '
import json, sys
try: d = json.loads(sys.stdin.read())
except Exception: d = {}
print("1" if d.get("ok") is True and d.get("newest_offhost_listed") is True else "0", d.get("newest_offhost_age_s", "-"), d.get("newest_offhost") or "-", d.get("newest_backup") or "-")') || true
  if [ "$check_rc" = 0 ] && [ "${ok:-0}" = 1 ]; then results+=("PASS  freshness check: newest object in $DEST is $newest_remote, ${age}s old (limit 7200s)")
  else printf '%s\n' "$check_out" | tail -5 >&2; results+=("FAIL  freshness check (the check's own output is above)"); fi
else results+=("FAIL  freshness check (not run: the backup did not pass)"); fi

# ---- 6. the restore test: the snapshot that was just uploaded, restored into a temporary file
if [[ ${results[1]} == PASS* ]]; then
  if [ "$newest_remote" != "$newest_local.age" ]; then results+=("FAIL  restore test: the newest object in the bucket ($newest_remote) is not the copy of the newest local backup ($newest_local)")
  else
    backups=$(sed -n 's/^BACKUP_DIR=//p' "$ETC/env" | tail -1)
    # restore-drill.ts restores into a throwaway directory of its own, compares it with the backup and removes it
    drill=(node --experimental-strip-types --no-warnings scripts/backup/restore-drill.ts --backup "$backups/$newest_local")
    [ -n "$ROOT" ] || drill=(sudo -u "$APP_USER" "${drill[@]}")
    if drill_out=$(cd "$RELEASE/web" && "${drill[@]}" 2>&1) && printf '%s\n' "$drill_out" | grep -q 'restore drill: PASS' && printf '%s\n' "$drill_out" | grep -q 'integrity_check: ok'; then
      results+=("PASS  restore test: $newest_local restored into a temporary file; PRAGMA integrity_check ok, $(printf '%s\n' "$drill_out" | sed -n 's/^ *tables compared, backup vs restored: //p') tables match (temporary copy removed)")
    else printf '%s\n' "$drill_out" | tail -8 >&2; results+=("FAIL  restore test (restore-drill output is above)"); fi
  fi
else results+=("FAIL  restore test (not run: the freshness check did not pass)"); fi

echo
failed=0
for r in "${results[@]}"; do echo "$r"; [[ $r == PASS* ]] || failed=1; done
echo
if [ "$failed" = 0 ]; then
  cat <<EOF
install-prod-offhost: ALL PASS. Backups now run every hour and leave this box encrypted; the check runs every 15 minutes.
  Still to do, on the owner's machine (this box cannot do it, by design):
    bash ops/backup/restore-s3.sh --bucket $BUCKET --identity ~/dazl-backup-keys/dazl-offhost-identity.txt --out ~/dazl-restore-test
  Then delete the copied key file here:  shred -u $CRED
EOF
  exit 0
fi
echo "install-prod-offhost: NOT DONE: at least one step FAILED (above). Fix the cause and run this again; it is safe to re-run." >&2
exit 1
