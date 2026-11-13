#!/usr/bin/env bash
# Production deploy for dazl.ai (web/docs/DEPLOY.md, "Deploying a prebuilt release"), run by the ops door as root.
#   deploy-prod.sh <40-hex sha>   check out sha's source in $RELEASE_ROOT/dazl-<sha8>-prod, unpack its PREBUILT build
#                                 (ops/prod/pull-release.sh: built on GitHub, verified here; the box never runs npm ci,
#                                 tsc or next build), take a verified backup of the database, migrate, start it on the
#                                 spare port (3104/3105) as the app user, wait for /api/health = sha, switch Caddy, verify
#                                 publicly. The old release keeps running, so rollback is instant.
#   deploy-prod.sh --rollback     point Caddy back at the previous release, only if it still answers with its own commit.
# Root never runs anything the app user can replace: this script and pull-release.sh must be installed root-owned
# (/usr/local/lib/dazl-prod), the app's env file is parsed as data (never sourced by root), and everything inside a
# release (migrate, next start, the checkout, the unpack) runs as the app user. One deploy or rollback at a time.
# Disk: refuses unless at least $PROD_MIN_FREE_BYTES (3 GiB) stays free after the downloads, the unpacked release and
# the database backup.
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SELF=$HERE/$(basename "${BASH_SOURCE[0]}")
CADDY=${PROD_CADDYFILE:-/etc/caddy/Caddyfile}
OPS=${PROD_OPS_DIR:-/etc/dazl-ops}
STATE=$OPS/prod-state
DB=${PROD_DB:-/home/ubuntu/dazl-data/dazl-pr16.db}
RELEASE_ROOT=${PROD_RELEASE_ROOT:-/home/ubuntu}
BACKUPS=${PROD_BACKUP_DIR:-/var/lib/dazl-prod-backups}
KEEP_BACKUPS=${PROD_KEEP_BACKUPS-10}
APP_USER=${PROD_APP_USER:-ubuntu}
RUN_ENV=${PROD_RUN_ENV:-/home/ubuntu/dazl-pr16-run.env}
REPO_URL=${PROD_REPO_URL:-https://github.com/gagan114662/dazl.git}
PUBLIC_URL=${PROD_PUBLIC_URL:-https://dazl.ai}
TRUSTED_UID=${PROD_TRUSTED_UID:-0}  # tests stand in a test user for root; the ops door never sets it
export PROD_MIN_FREE_BYTES=${PROD_MIN_FREE_BYTES:-3221225472}
PULL=$HERE/pull-release.sh
log() { echo "$(date -Is) $*"; }
die() { log "$*"; exit 1; }
as_app() { if [ "$(id -un)" = "$APP_USER" ]; then "$@"; else sudo -u "$APP_USER" -- "$@"; fi; }
health_sha() { curl -s "$1/api/health" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("commit",""))' 2>/dev/null || true; }

# A file root runs (this script, pull-release.sh) must be a regular file owned by root and writable by root only, in
# directories that are all root-owned and root-writable only (a sticky world-writable one only with a root-owned child).
trusted_path() {
  local p=$1 owner mode dir child st
  [ -f "$p" ] && [ ! -L "$p" ] || return 1
  read -r owner mode < <(stat -c '%u %a' -- "$p") || return 1
  [ "$owner" = "$TRUSTED_UID" ] && (( (8#$mode & 8#022) == 0 )) || return 1
  child=$p; dir=$(dirname -- "$p")
  while :; do
    [ ! -L "$dir" ] && [ -d "$dir" ] || return 1
    read -r owner mode < <(stat -c '%u %a' -- "$dir") || return 1
    [ "$owner" = "$TRUSTED_UID" ] || [ "$owner" = 0 ] || return 1
    if (( (8#$mode & 8#022) != 0 )); then
      (( (8#$mode & 8#1000) != 0 )) || return 1
      st=$(stat -c %u -- "$child") || return 1
      [ "$st" = "$TRUSTED_UID" ] || [ "$st" = 0 ] || return 1
    fi
    [ "$dir" = / ] && break
    child=$dir; dir=$(dirname -- "$dir")
  done
}
for f in "$SELF" "$PULL"; do
  trusted_path "$f" || die "$f is not trusted (it, or a directory above it, is not root-owned and root-writable only): install ops/prod/*.sh root-owned in /usr/local/lib/dazl-prod (web/docs/DEPLOY.md); nothing done"
done
[[ $KEEP_BACKUPS =~ ^[1-9][0-9]{0,3}$ ]] || die "PROD_KEEP_BACKUPS must be a whole number of at least 1; nothing done"

live_port() { python3 - "$CADDY" <<'PY'
import re, sys
print(re.search(r'dazl\.ai, www\.dazl\.ai \{[^}]*?reverse_proxy localhost:(\d+)', open(sys.argv[1]).read()).group(1))
PY
}
switch_caddy() {  # $1 = new port
  cp -a "$CADDY" "$CADDY.bak-ops-$(date +%Y%m%dT%H%M%S)"
  python3 - "$CADDY" "$1" <<'PY'
import re, sys
p = sys.argv[1]; t = open(p).read()
n = re.sub(r'(dazl\.ai, www\.dazl\.ai \{[^}]*?reverse_proxy localhost:)\d+', r'\g<1>' + sys.argv[2], t, count=1)
assert n != t, 'caddy block not changed'
open(p, 'w').write(n)
PY
  caddy validate --config "$CADDY" --adapter caddyfile >/dev/null
  systemctl reload caddy
}
listener_cwds() { ss -ltnpH | grep -oP 'pid=\K[0-9]+' | sort -u | while read -r p; do readlink "/proc/$p/cwd" 2>/dev/null || true; done; }
port_pid() { ss -ltnpH "sport = :$1" | grep -oP 'pid=\K[0-9]+' | head -1 || true; }
write_state() { printf 'PREV_PORT=%s\nPREV_SHA=%s\nNEW_SHA=%s\n' "$1" "$2" "$3" > "$STATE.tmp"; mv -f "$STATE.tmp" "$STATE"; }

# one deploy or rollback at a time (two would pick the same spare port and stop each other's process)
[ ! -L "$OPS" ] || die "$OPS is a symlink; nothing done"
install -d -m 700 "$OPS"
exec 9>"$OPS/deploy.lock"; flock -n 9 || die "another deploy or rollback is running; nothing done"

if [ "${1:-}" = "--rollback" ]; then
  [ -f "$STATE" ] || die "no previous deploy recorded"
  PREV_PORT=; PREV_SHA=; NEW_SHA=
  . "$STATE"
  [[ $PREV_PORT =~ ^310[45]$ ]] && [[ $PREV_SHA =~ ^[0-9a-f]{40}$ ]] || die "no rollback target recorded (a later deploy stopped it); deploy the commit you want instead"
  cur=$(live_port)
  log "rollback: dazl.ai $cur -> $PREV_PORT"
  got=$(health_sha "http://127.0.0.1:$PREV_PORT")
  [ "$got" = "$PREV_SHA" ] || die "previous port $PREV_PORT answers '${got:-nothing}', not the recorded $PREV_SHA; refusing"
  switch_caddy "$PREV_PORT"
  write_state "$cur" "$NEW_SHA" "$PREV_SHA"
  sleep "${PROD_SWITCH_SLEEP:-2}"; curl -s "$PUBLIC_URL/api/health"; echo; exit 0
fi

SHA=${1:?usage: deploy-prod.sh <40-hex sha> | --rollback}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || die "not a full commit: $SHA"
S8=${SHA:0:8}
DIR=$RELEASE_ROOT/dazl-$S8-prod
LIVE=$(live_port)
NEW=$([ "$LIVE" = 3104 ] && echo 3105 || echo 3104)
LIVE_PID=$(port_pid "$LIVE")
LIVE_WEB=$(readlink "/proc/$LIVE_PID/cwd" 2>/dev/null || true)
log "live port $LIVE (pid $LIVE_PID, ${LIVE_WEB:-unknown dir}), new port $NEW, sha $SHA"

# the database migrate will change: the env's DB_PATH must be exactly $DB, a regular file (no symlink, one link)
[ -f "$DB" ] && [ ! -L "$DB" ] || die "the database $DB is missing or not a regular file; nothing done"
[ "$(stat -c %h -- "$DB")" = 1 ] || die "the database $DB has another hard link; nothing done"
as_app test -w "$DB" || die "the database $DB is not writable by $APP_USER (the app and migrate run as $APP_USER: chown it once, web/docs/DEPLOY.md); nothing done"
db_bytes=$(stat -c %s -- "$DB")
for fs in "$RELEASE_ROOT" "$(dirname "$BACKUPS")"; do
  [ "$(df --output=avail -B1 "$fs" | tail -1)" -gt $(( PROD_MIN_FREE_BYTES + db_bytes )) ] || die "less than $PROD_MIN_FREE_BYTES bytes plus the backup ($db_bytes) free on $fs; refusing"
done

# 1. the new release's environment: the live process's environment plus the run env, parsed as DATA (never sourced by
#    root: a value like $(cmd) stays text) and shell-quoted, minus PORT; root-only.
python3 - "$LIVE_PID" "$RUN_ENV" > "$OPS/prod.env.next" <<'PY'
import os, re, shlex, sys
env = {}
for kv in open(f'/proc/{sys.argv[1]}/environ', 'rb').read().split(b'\0'):
    if b'=' in kv:
        k, v = kv.decode(errors='replace').split('=', 1); env[k] = v
try:
    lines = open(sys.argv[2], encoding='utf-8', errors='replace').read().splitlines()
except FileNotFoundError:
    lines = []
for line in lines:
    m = re.match(r'^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$', line)
    if not m:
        continue
    v = m.group(2)
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '\'"':
        v = v[1:-1]  # one level of quotes, nothing expanded
    env[m.group(1)] = v
for k, v in env.items():
    if k in ('PORT', '_', 'PWD', 'OLDPWD', 'SHLVL') or not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', k):
        continue
    print(f'{k}={shlex.quote(v)}')
PY
envdb=$(python3 - "$OPS/prod.env.next" <<'PY'
import shlex, sys
for line in open(sys.argv[1]):
    if line.startswith('DB_PATH='):
        print(shlex.split(line.split('=', 1)[1])[0] if line.split('=', 1)[1].strip() else ''); break
PY
)
[ "$(readlink -f -- "${envdb:-/nonexistent}")" = "$(readlink -f -- "$DB")" ] || die "the release's DB_PATH (${envdb:-unset}) is not $DB, the database this deploy backs up; nothing done"

# 2. the release, as the app user: source checked out, the build PREBUILT on GitHub (never built here)
reuse=0
if [ -d "$DIR" ] && listener_cwds | grep -q "^$DIR"; then
  [ "$(as_app cat "$DIR/web/.build-commit" 2>/dev/null)" = "$SHA" ] && [ -n "$(as_app cat "$DIR/web/.next/BUILD_ID" 2>/dev/null)" ] \
    || die "$DIR is in use by a live process and is not a complete build of $SHA; refusing"
  log "$DIR is live and a complete build of $SHA: reusing it"; reuse=1
fi
if [ $reuse = 0 ]; then
  bash "$PULL" fetch "$SHA"  # verified download + disk floor; fails before anything on the box changes
  as_app rm -rf -- "$DIR"
  as_app git clone -q --filter=blob:none "$REPO_URL" "$DIR"
  as_app git -C "$DIR" checkout -q "$SHA"
  as_app bash "$PULL" extract "$SHA" "$DIR/web" "$LIVE_WEB" || { as_app rm -rf -- "$DIR"; die "the prebuilt build of $SHA did not unpack; prod untouched"; }
fi
# the app user's copy of the release env (it is the app's own runtime environment), written by the app user
as_app bash -c 'umask 077; cat > "$1"' _ "$DIR/.release.env" < "$OPS/prod.env.next"

# 3. a VERIFIED backup of the database (online backup API, integrity_check ok), root-only, newest $KEEP_BACKUPS kept
[ ! -L "$BACKUPS" ] || die "$BACKUPS is a symlink; nothing done"
install -d -m 700 "$BACKUPS"
BK=$BACKUPS/predeploy-$S8-$(date +%Y%m%dT%H%M%S).db
python3 - "$DB" "$BK.tmp" <<'PY' || { rm -f -- "$BK.tmp"; die "the database backup failed; prod untouched"; }
import sqlite3, sys, urllib.parse
src = sqlite3.connect('file:%s?mode=ro' % urllib.parse.quote(sys.argv[1]), uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()
r = sqlite3.connect(sys.argv[2]).execute('pragma integrity_check').fetchone()[0]
if r != 'ok': sys.exit('integrity_check: %s' % r)
PY
mv -f -- "$BK.tmp" "$BK"
ls -1t "$BACKUPS"/predeploy-*.db 2>/dev/null | tail -n +$(( KEEP_BACKUPS + 1 )) | xargs -r rm -f --
log "db backup $BK ($(stat -c %s "$BK") bytes, integrity ok)"

# 4. migrate, then start on the spare port: both as the app user, in the release (a script run and next start: no build)
# fd 9 (the deploy lock) is closed for everything the release runs: a long-lived next start must never hold the lock
in_release() { as_app bash -c 'cd "$1/web" && set -a && . "$1/.release.env" && set +a && shift && "$@"' _ "$DIR" "$@" 9>&-; }
in_release npm run -s db:migrate || die "migration failed; prod untouched (backup at $BK)"
OLD_ON_NEW=$(port_pid "$NEW")
if [ -n "$OLD_ON_NEW" ]; then
  # that is the rollback target of the live release: from here on there is no recorded rollback until this deploy ends
  [ ! -f "$STATE" ] || { . "$STATE"; write_state none "" "${NEW_SHA:-}"; }
  log "stopping the previous release $OLD_ON_NEW on $NEW"; kill "$OLD_ON_NEW" || true; sleep "${PROD_STOP_SLEEP:-3}"
fi
in_release bash -c 'PORT=$1 nohup npx next start -p "$1" > "$2" 2>&1 &' _ "$NEW" "$DIR/next-start.log"
stop_new() { local p; p=$(port_pid "$NEW"); [ -z "$p" ] || kill "$p" || true; }
c=
for _ in $(seq 1 "${PROD_HEALTH_TRIES:-90}"); do c=$(health_sha "http://127.0.0.1:$NEW"); [ "$c" = "$SHA" ] && break; sleep "${PROD_HEALTH_SLEEP:-2}"; done
[ "$c" = "$SHA" ] || { as_app tail -30 "$DIR/next-start.log" || true; stop_new; die "new release did not report $SHA on :$NEW; NOT switching (dazl.ai still on :$LIVE); stopped it"; }

# 5. switch, verify publicly, record rollback state
OLD_SHA=$(health_sha "http://127.0.0.1:$LIVE")
switch_caddy "$NEW"
sleep "${PROD_SWITCH_SLEEP:-3}"
pub=$(health_sha "$PUBLIC_URL")
if [ "$pub" != "$SHA" ]; then switch_caddy "$LIVE"; stop_new; die "public health shows '$pub', not $SHA: switched back to :$LIVE, stopped the new release"; fi
mv -f "$OPS/prod.env.next" "$OPS/prod.env"
write_state "$LIVE" "$OLD_SHA" "$SHA"

# 6. disk: keep the live release and the previous one (the instant rollback target); remove older release directories
#    that no listener runs from (as the app user, in its own directory)
keep=" $DIR ${LIVE_WEB%/web} "
for d in "$RELEASE_ROOT"/dazl-*-prod; do
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  case "$keep" in *" $d "*) continue ;; esac
  listener_cwds | grep -q "^$d" && continue
  log "removing old release $d"; as_app rm -rf -- "$d"
done
log "DONE: dazl.ai now $SHA on :$NEW. Previous $OLD_SHA still running on :$LIVE (deploy-prod.sh --rollback to switch back)."
