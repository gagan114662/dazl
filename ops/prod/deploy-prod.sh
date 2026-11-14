#!/usr/bin/env bash
# dazl.ai production deploy, v2 (2026-11-13, after the 14:20Z outage). Run as root, normally by the ops door
# (POST /__ops/deploy/prod?sha=..., POST /__ops/rollback/prod).
#
#   deploy-prod.sh <40-hex sha>    blue/green deploy of the PREBUILT build of <sha> (never builds on the box)
#   deploy-prod.sh --rollback      point dazl.ai back at the previous release (still running), verified
#   deploy-prod.sh --stop-port P   stop the release on port P to free memory; REFUSES if Caddy points at P
#   deploy-prod.sh --status        live port, both ports' commit/instance, unit states, rollback target
#
# Deploy steps (any failure before the switch leaves dazl.ai untouched; any failure after it switches back):
#   0. preflight: one deploy at a time (global lock), live port read from Caddy, live release answers, enough RAM
#   1. verified sqlite .backup of the prod DB (online backup API + integrity_check), BEFORE anything else changes
#   2. pull-release.sh fetch: download the GitHub-built prebuilt artifact, verify size + sha256 + .build-commit
#   3. source checkout + pull-release.sh extract (as the app user); env = live process env + run env, parsed as data
#   4. migrate (as the app user)
#   5. free the SPARE port: stop whatever release runs there (never the live port), wait until the port is closed
#   6. start dazl-prod@<spare>.service: a supervised systemd unit (Restart=on-failure), NOT a child of this script,
#      so it survives the deploy/ops door exiting. Wait until /api/health = sha AND the listener is that unit's process
#   7. local smoke on the spare port (/, /sign-in = 200)
#   8. switch Caddy: write Caddyfile.next, caddy validate, swap, reload (restore + reload on failure)
#   9. public smoke (/, /sign-in = 200, /api/health commit = sha, instance = the new process), then a stability window
#      (unit still active, no restarts, public still = sha). Any failure: switch Caddy back to the old port, verify it,
#      then stop the failed new unit
#  10. enable the new unit at boot, disable the old port's unit (it keeps RUNNING: instant rollback), record state
#
# Invariant: this script never stops the port Caddy points at, and never stops the port it just started while Caddy
# points at it (stop_port() re-reads the Caddyfile and refuses).
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SELF=$HERE/$(basename "${BASH_SOURCE[0]}")
PULL=$HERE/pull-release.sh
RUNNER=$HERE/run-release.sh
CADDY=${PROD_CADDYFILE:-/etc/caddy/Caddyfile}
CADDY_SITE=${PROD_CADDY_SITE:-dazl.ai, www.dazl.ai}          # the site block whose reverse_proxy port is switched
CADDY_RELOAD=${PROD_CADDY_RELOAD:-systemctl reload caddy}
OPS=${PROD_OPS_DIR:-/etc/dazl-ops}
STATE=$OPS/prod-state
PORTCONF=${PROD_PORTCONF_DIR:-/etc/dazl-prod/ports}             # fixed: the unit template reads it
DB=${PROD_DB:-/home/ubuntu/dazl-data/dazl-pr16.db}
RELEASE_ROOT=${PROD_RELEASE_ROOT:-/home/ubuntu}
RELEASE_ROOT=${RELEASE_ROOT%/}
BACKUPS=${PROD_BACKUP_DIR:-/var/lib/dazl-prod-backups}
KEEP_BACKUPS=${PROD_KEEP_BACKUPS-10}
APP_USER=${PROD_APP_USER:-ubuntu}
RUN_ENV=${PROD_RUN_ENV:-/home/ubuntu/dazl-pr16-run.env}
REPO_URL=${PROD_REPO_URL:-https://github.com/gagan114662/dazl.git}
PUBLIC_URL=${PROD_PUBLIC_URL:-https://dazl.ai}
PORTS=${PROD_PORTS:-3104 3105}
SMOKE_PATHS=${PROD_SMOKE_PATHS:-/ /sign-in}
STABLE_S=${PROD_STABLE_S:-15}
MIN_AVAIL_MB=${PROD_MIN_AVAIL_MB:-300}
ENABLE_AT_BOOT=${PROD_ENABLE_AT_BOOT:-1}
PRUNE=${PROD_PRUNE:-1}
GLOBAL_LOCK=/run/lock/dazl-prod-deploy.lock
export PROD_MIN_FREE_BYTES=${PROD_MIN_FREE_BYTES:-3221225472}

log() { echo "$(date -Is) $*"; }
die() { log "FAIL: $*"; exit 1; }
as_user() { local u=$1; shift; if [ "$(id -un)" = "$u" ]; then "$@"; else sudo -u "$u" -- "$@"; fi; }
as_app() { as_user "$APP_USER" "$@"; }
[[ ${PROD_HEALTH_MAX_TIME:-10} =~ ^[1-9][0-9]?$ ]] || { echo "PROD_HEALTH_MAX_TIME must be 1-99 seconds" >&2; exit 1; }
# prints "<commit> <instance>" (empty fields when there is no answer). Every read is bounded.
health() { { curl -s --connect-timeout 5 --max-time "${PROD_HEALTH_MAX_TIME:-10}" "$1/api/health" 2>/dev/null || true; } | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
if not isinstance(d, dict): d={}
print(d.get("commit","") or "-", d.get("instance","") or "-")' 2>/dev/null || echo "- -"; }
health_sha() { health "$1" | cut -d" " -f1 | sed 's/^-$//'; }
http_code() { curl -s -o /dev/null --connect-timeout 5 --max-time "${PROD_HEALTH_MAX_TIME:-10}" -w '%{http_code}' "$1" || echo 000; }

read -r PORT_A PORT_B <<< "$PORTS"
[[ $PORT_A =~ ^31[0-9]{2}$ && $PORT_B =~ ^31[0-9]{2}$ && $PORT_A != "$PORT_B" ]] || die "PROD_PORTS must be two different 31xx ports; nothing done"
[[ $STABLE_S =~ ^[0-9]{1,3}$ ]] || die "PROD_STABLE_S must be 0-999; nothing done"
[[ $MIN_AVAIL_MB =~ ^[0-9]{1,5}$ ]] || die "PROD_MIN_AVAIL_MB must be a number; nothing done"
[[ $KEEP_BACKUPS =~ ^[1-9][0-9]{0,3}$ ]] || die "PROD_KEEP_BACKUPS must be >= 1; nothing done"
other_port() { [ "$1" = "$PORT_A" ] && echo "$PORT_B" || echo "$PORT_A"; }

# files root runs must be root-owned and not group/world-writable, in root-owned directories
trusted_path() {
  local p=$1 owner mode dir
  [ -f "$p" ] && [ ! -L "$p" ] || return 1
  read -r owner mode < <(stat -c '%u %a' -- "$p") || return 1
  [ "$owner" = 0 ] && (( (8#$mode & 8#022) == 0 )) || return 1
  dir=$(dirname -- "$p")
  while :; do
    [ ! -L "$dir" ] && [ -d "$dir" ] || return 1
    read -r owner mode < <(stat -c '%u %a' -- "$dir") || return 1
    [ "$owner" = 0 ] || return 1
    (( (8#$mode & 8#022) == 0 )) || (( (8#$mode & 8#1000) != 0 )) || return 1
    [ "$dir" = / ] && break
    dir=$(dirname -- "$dir")
  done
}
for f in "$SELF" "$PULL" "$RUNNER"; do
  trusted_path "$f" || die "$f is not root-owned / root-writable only; nothing done"
done

caddy_regex() { python3 -c 'import re,sys;print(re.escape(sys.argv[1]))' "$CADDY_SITE"; }
live_port() { python3 - "$CADDY" "$(caddy_regex)" <<'PY'
import re, sys
m = re.search(sys.argv[2] + r' \{[^}]*?reverse_proxy localhost:(\d+)', open(sys.argv[1]).read())
print(m.group(1) if m else '')
PY
}
switch_caddy() {  # $1 = port. Validated before it replaces the live file; a failed reload restores the old file.
  local bak; bak="$CADDY.bak-ops-$(date +%Y%m%dT%H%M%S)"
  cp -a "$CADDY" "$bak"
  python3 - "$CADDY" "$1" "$CADDY.next" "$(caddy_regex)" <<'PY'
import re, sys
t = open(sys.argv[1]).read()
n = re.sub('(' + sys.argv[4] + r' \{[^}]*?reverse_proxy localhost:)\d+', r'\g<1>' + sys.argv[2], t, count=1)
if n == t and ('localhost:' + sys.argv[2]) not in t:
    sys.exit('caddy site block not found')
open(sys.argv[3], 'w').write(n)
PY
  caddy validate --config "$CADDY.next" --adapter caddyfile >/dev/null 2>&1 || { rm -f -- "$CADDY.next"; log "caddy validate refused the new config"; return 1; }
  chown --reference="$CADDY" "$CADDY.next" && chmod --reference="$CADDY" "$CADDY.next"
  mv -f -- "$CADDY.next" "$CADDY"
  if ! $CADDY_RELOAD >/dev/null 2>&1; then cp -a "$bak" "$CADDY"; $CADDY_RELOAD >/dev/null 2>&1 || true; log "caddy reload failed; previous config restored"; return 1; fi
  [ "$(live_port)" = "$1" ] || { log "Caddyfile does not point at :$1 after the switch"; return 1; }
  log "caddy: $CADDY_SITE -> localhost:$1 (validated, reloaded; backup $bak)"
  ls -1t "$CADDY".bak-ops-* 2>/dev/null | tail -n +21 | xargs -r rm -f --
}

port_pids() { ss -l -t -n -p -H "sport = :$1" | grep -oP 'pid=\K[0-9]+' | sort -u || true; }
pid_cgroup() { sed -n 's/^0:://p' "/proc/$1/cgroup" 2>/dev/null || true; }
unit_of() { local cg; cg=$(pid_cgroup "$1"); basename -- "${cg:-/}"; }
release_web() { [[ $1 =~ ^/.+/dazl-[0-9a-f]{8}-prod/web$ ]]; }
unit_active() { systemctl is-active --quiet "dazl-prod@$1.service"; }

# Stop whatever release listens on port $1. Refuses when Caddy points at $1 (re-read NOW, not cached).
# Knows three kinds: our unit dazl-prod@$1, a legacy transient dazl-prod-deploy-*.scope/.service, or a process whose
# cwd is a dazl-<sha8>-prod/web release dir. Anything else on the port is not ours: refuse. Waits until it is closed.
stop_port() {
  local port=$1 why=$2 p u cwd live real
  live=$(live_port)
  [ -n "$live" ] || { log "REFUSING to stop :$port: cannot read the live port from $CADDY"; return 1; }
  [ "$port" != "$live" ] || { log "REFUSING to stop :$port: Caddy points dazl.ai at it ($why)"; return 1; }
  # absolute guard, independent of PROD_CADDYFILE/PROD_CADDY_SITE overrides: never stop the port the REAL dazl.ai
  # Caddy block points at (a test run or a mis-set override must not be able to take prod down)
  real=$(python3 -c 'import re,sys
m=re.search(r"dazl\.ai, www\.dazl\.ai \{[^}]*?reverse_proxy localhost:(\d+)", open("/etc/caddy/Caddyfile").read())
print(m.group(1) if m else "")' 2>/dev/null || true)
  [ -n "$real" ] || { log "REFUSING to stop :$port: cannot read the real dazl.ai port from /etc/caddy/Caddyfile"; return 1; }
  [ "$port" != "$real" ] || { log "REFUSING to stop :$port: the REAL dazl.ai Caddy block points at it ($why)"; return 1; }
  # always stop the unit (also catches 'activating'/auto-restart after a crash, which is-active does not report)
  if [ "$(systemctl show -p ActiveState --value "dazl-prod@$port.service" 2>/dev/null)" != inactive ]; then
    log "stopping dazl-prod@$port.service ($why)"
  fi
  systemctl stop "dazl-prod@$port.service" 2>/dev/null || true
  systemctl reset-failed "dazl-prod@$port.service" 2>/dev/null || true
  for p in $(port_pids "$port"); do
    u=$(unit_of "$p"); cwd=$(readlink "/proc/$p/cwd" 2>/dev/null || true)
    if [[ $u =~ ^dazl-prod-deploy-[A-Za-z0-9-]+\.(scope|service)$ ]]; then
      log "stopping legacy $u (pid $p, $cwd) on :$port ($why)"; systemctl stop "$u" || kill "$p" || true
    elif release_web "$cwd"; then
      log "stopping legacy release pid $p ($cwd, cgroup $u) on :$port ($why)"; kill "$p" || true
      local pp; pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); [ -n "$pp" ] && ps -o args= -p "$pp" 2>/dev/null | grep -q "next start -p $port" && kill "$pp" 2>/dev/null || true
    else
      log "REFUSING: pid $p on :$port is not a dazl release (cwd ${cwd:-?}, cgroup ${u:-?})"; return 1
    fi
  done
  for _ in $(seq 1 30); do [ -z "$(port_pids "$port")" ] && { log ":$port is closed"; return 0; }; sleep 1; done
  for p in $(port_pids "$port"); do log "pid $p still on :$port after 30s: SIGKILL"; kill -9 "$p" 2>/dev/null || true; done
  sleep 2; [ -z "$(port_pids "$port")" ] || { log ":$port is still in use"; return 1; }
}

write_state() { printf 'PREV_PORT=%s\nPREV_SHA=%s\nNEW_SHA=%s\nNEW_PORT=%s\n' "$1" "$2" "$3" "$4" > "$STATE.tmp"; mv -f "$STATE.tmp" "$STATE"; }
set_boot() {  # $1 = port that should start at boot (only when this is the real Caddy)
  [ "$ENABLE_AT_BOOT" = 1 ] || return 0
  local o; o=$(other_port "$1")
  if unit_active "$1"; then systemctl enable --quiet "dazl-prod@$1.service" && log "dazl-prod@$1 enabled at boot"
  else
    # legacy (pre-v2) process on that port: point the port's unit at the same release dir and enable it, so a reboot
    # brings back exactly what Caddy points at (the unit is not started now: the legacy process serves)
    local lp lc; lp=$(port_pids "$1" | head -1); lc=$(readlink "/proc/${lp:-0}/cwd" 2>/dev/null || true)
    if release_web "$lc" && [ -f "${lc%/web}/.release.env" ]; then
      printf 'DAZL_RELEASE=%s\n' "${lc%/web}" > "$PORTCONF/$1.conf"; chmod 644 "$PORTCONF/$1.conf"
      systemctl enable --quiet "dazl-prod@$1.service" && log "legacy process on :$1: dazl-prod@$1 enabled at boot for ${lc%/web}"
    else log "WARNING: :$1 runs a legacy process from ${lc:-?}: nothing will start it after a reboot"; fi
  fi
  systemctl disable --quiet "dazl-prod@$o.service" 2>/dev/null || true
}
# public smoke: every path 200, health commit = $1, and (if given) instance = $2. Retries for ~20 s.
public_smoke() {
  local want=$1 inst=${2:-} t c i code pth ok
  for t in $(seq 1 10); do
    ok=1
    read -r c i < <(health "$PUBLIC_URL")
    [ "$c" = "$want" ] || ok=0
    [ -z "$inst" ] || [ "$i" = "$inst" ] || ok=0
    for pth in $SMOKE_PATHS; do code=$(http_code "$PUBLIC_URL$pth"); [ "$code" = 200 ] || { ok=0; log "smoke try $t: $PUBLIC_URL$pth -> $code"; }; done
    if [ $ok = 1 ]; then log "public smoke ok: $PUBLIC_URL commit $c instance $i; paths [$SMOKE_PATHS] all 200"; return 0; fi
    log "smoke try $t: health commit=${c} instance=${i} (want $want${inst:+ / $inst})"; sleep 2
  done
  return 1
}

[ ! -L "$OPS" ] || die "$OPS is a symlink; nothing done"
install -d -m 700 "$OPS"; install -d -m 755 "$(dirname "$PORTCONF")"; install -d -m 755 "$PORTCONF"

status() {
  local live p; live=$(live_port); echo "live port (Caddy $CADDY_SITE): ${live:-?}"
  for p in $PORT_A $PORT_B; do
    echo ":$p health=[$(health "http://127.0.0.1:$p")] unit=$(systemctl is-active "dazl-prod@$p.service" 2>/dev/null) enabled=$(systemctl is-enabled "dazl-prod@$p.service" 2>/dev/null) pids=[$(port_pids "$p" | tr '\n' ' ')] cgroup=[$(for x in $(port_pids "$p"); do unit_of "$x"; done | tr '\n' ' ')]"
  done
  [ -f "$STATE" ] && sed 's/^/state: /' "$STATE" || echo "state: none"
  free -m | sed -n 2p
}
[ "${1:-}" = --status ] && { status; exit 0; }   # read-only: no lock needed
exec 8>"$GLOBAL_LOCK"; flock -n 8 || die "another prod deploy/rollback is running (lock $GLOBAL_LOCK); nothing done"
case "${1:-}" in
  --status) status; exit 0 ;;
  --stop-port)
    P=${2:-}; [ "$P" = "$PORT_A" ] || [ "$P" = "$PORT_B" ] || die "--stop-port takes $PORT_A or $PORT_B"
    stop_port "$P" "--stop-port by operator" || die "did not stop :$P"
    systemctl disable --quiet "dazl-prod@$P.service" 2>/dev/null || true
    if [ -f "$STATE" ] && grep -qx "PREV_PORT=$P" "$STATE"; then NEW_SHA=; NEW_PORT=; . "$STATE"; write_state none "" "${NEW_SHA:-}" "${NEW_PORT:-}"; log "rollback target on :$P is gone: state updated"; fi
    log "stopped :$P"; free -m | sed -n 2p; exit 0 ;;
  --rollback)
    [ -f "$STATE" ] || die "no previous deploy recorded"
    PREV_PORT=; PREV_SHA=; NEW_SHA=; NEW_PORT=
    . "$STATE"
    [[ $PREV_PORT =~ ^31[0-9]{2}$ ]] && [[ $PREV_SHA =~ ^[0-9a-f]{40}$ ]] || die "no rollback target recorded; deploy the commit you want instead"
    cur=$(live_port); [ -n "$cur" ] || die "cannot read the live port"
    [ "$cur" != "$PREV_PORT" ] || die "dazl.ai already points at :$PREV_PORT"
    read -r got ginst < <(health "http://127.0.0.1:$PREV_PORT")
    [ "$got" = "$PREV_SHA" ] || die "previous port $PREV_PORT answers '$got', not the recorded $PREV_SHA; refusing (nothing changed)"
    log "rollback: dazl.ai :$cur ($NEW_SHA) -> :$PREV_PORT ($PREV_SHA, instance $ginst)"
    switch_caddy "$PREV_PORT" || die "caddy switch failed; dazl.ai still on :$cur"
    if ! public_smoke "$PREV_SHA" "$ginst"; then
      switch_caddy "$cur" || true
      die "public smoke failed after the rollback: switched back to :$cur"
    fi
    write_state "$cur" "$NEW_SHA" "$PREV_SHA" "$PREV_PORT"
    set_boot "$PREV_PORT"
    log "ROLLED BACK: dazl.ai now $PREV_SHA on :$PREV_PORT; $NEW_SHA still running on :$cur (rollback again to return)"; exit 0 ;;
esac

SHA=${1:?usage: deploy-prod.sh <40-hex sha> | --rollback | --stop-port <port> | --status}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || die "not a full commit: $SHA"
S8=${SHA:0:8}
DIR=$RELEASE_ROOT/dazl-$S8-prod
T0=$(date +%s)
LIVE=$(live_port); [ "$LIVE" = "$PORT_A" ] || [ "$LIVE" = "$PORT_B" ] || die "Caddy points $CADDY_SITE at '${LIVE:-nothing}', not $PORT_A/$PORT_B; nothing done"
NEW=$(other_port "$LIVE")
LIVE_PID=$(port_pids "$LIVE" | head -1)
[[ $LIVE_PID =~ ^[0-9]+$ ]] || die "nothing listens on the live port $LIVE; nothing done"
LIVE_WEB=$(readlink "/proc/$LIVE_PID/cwd" 2>/dev/null || true)
[ -n "$LIVE_WEB" ] || die "cannot read the live process's directory; nothing done"
OLD_SHA=; OLD_INST=
for _ in 1 2 3; do read -r OLD_SHA OLD_INST < <(health "http://127.0.0.1:$LIVE"); [[ $OLD_SHA =~ ^[0-9a-f]{40}$ ]] && break; sleep 2; done
[[ $OLD_SHA =~ ^[0-9a-f]{40}$ ]] || { log "WARNING: live :$LIVE did not report its commit: no rollback target after this deploy"; OLD_SHA=; }
log "START deploy $SHA: live :$LIVE (pid $LIVE_PID, $LIVE_WEB, ${OLD_SHA:-?} instance $OLD_INST, unit $(unit_of "$LIVE_PID")), spare :$NEW"
log "memory before: $(free -m | awk '/^Mem/{print "used "$3" MB, available "$7" MB"} /^Swap/{print "swap used "$3" MB"}' | tr '\n' ' ')"

# --- DB checks
[ -f "$DB" ] && [ ! -L "$DB" ] || die "the database $DB is missing or not a regular file; nothing done"
[ "$(stat -c %h -- "$DB")" = 1 ] || die "the database $DB has another hard link; nothing done"
as_app test -w "$DB" || die "$DB is not writable by $APP_USER; nothing done"
as_app test -w "$(dirname -- "$DB")" || die "$(dirname -- "$DB") is not writable by $APP_USER; nothing done"

# --- 1. verified backup FIRST
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
log "1/10 db backup $BK ($(stat -c %s "$BK") bytes, integrity ok)"

# --- env for the new release: live process env + run env, parsed as DATA (never sourced by root)
[ -n "$(as_app bash -c '[ -f "$1" ] && echo yes' _ "$RUN_ENV")" ] || die "the run env $RUN_ENV is missing; nothing done"
as_app cat -- "$RUN_ENV" > "$OPS/run.env.read" || die "cannot read $RUN_ENV as $APP_USER; nothing done"
python3 - "$LIVE_PID" "$OPS/run.env.read" > "$OPS/prod.env.next" <<'PY' || { rm -f -- "$OPS/run.env.read" "$OPS/prod.env.next"; die "the run env has a line that is not KEY=value data; nothing done"; }
import re, shlex, sys
env = {}
for kv in open(f'/proc/{sys.argv[1]}/environ', 'rb').read().split(b'\0'):
    if b'=' in kv:
        k, v = kv.decode(errors='replace').split('=', 1); env[k] = v
for n, line in enumerate(open(sys.argv[2], encoding='utf-8', errors='strict').read().splitlines(), 1):
    if not line.strip() or line.lstrip().startswith('#'):
        continue
    m = re.match(r"""^(?:export\s+)?([A-Z][A-Z0-9_]*)=(?:'([^']*)'|"([^"$`\\]*)"|([A-Za-z0-9_./:,@%+=-]*))\s*$""", line)
    if not m:
        print(f'prod deploy: run env line {n} is not KEY=value data', file=sys.stderr); sys.exit(1)
    env[m.group(1)] = next(g for g in m.groups()[1:] if g is not None)
drop = {'PORT', '_', 'PWD', 'OLDPWD', 'SHLVL', 'HOME', 'USER', 'LOGNAME', 'MAIL', 'PATH', 'XDG_RUNTIME_DIR', 'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'DAZL_RELEASE', 'MANAGERPID'}
for k, v in env.items():
    if k in drop or k.startswith('SUDO_') or not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', k):
        continue
    print(f'{k}={shlex.quote(v)}')
PY
rm -f -- "$OPS/run.env.read"
envdb=$(python3 - "$OPS/prod.env.next" <<'PY'
import shlex, sys
for line in open(sys.argv[1]):
    if line.startswith('DB_PATH='):
        print(shlex.split(line.split('=', 1)[1])[0] if line.split('=', 1)[1].strip() else ''); break
PY
)
[ "$(readlink -f -- "${envdb:-/nonexistent}")" = "$(readlink -f -- "$DB")" ] || die "the release's DB_PATH (${envdb:-unset}) is not $DB; nothing done"

# --- 2+3. prebuilt artifact: fetch (verify size/sha256/.build-commit), checkout, extract. Never npm ci / next build.
live_lock=
as_app test -d "$LIVE_WEB/node_modules" && live_lock=$(as_app sha256sum -- "$LIVE_WEB/package-lock.json" 2>/dev/null | cut -c1-64 || true)
db_bytes=$(stat -c %s -- "$BK")
if [ "$DIR/web" = "$LIVE_WEB" ]; then
  die "$SHA is already the live release on :$LIVE (same directory); nothing to deploy"
fi
PROD_RELEASE_ROOT=$RELEASE_ROOT PROD_BACKUP_DIR=$BACKUPS PROD_BACKUP_BYTES=0 PROD_LIVE_LOCK_SHA=$live_lock bash "$PULL" fetch "$SHA" || die "prebuilt fetch/verify failed; prod untouched"
log "2/10 prebuilt artifact verified"
# the spare's old release may run from $DIR (same sha redeployed): it is stopped in step 5 before $DIR is replaced
SPARE_FROM_DIR=0
for p in $(port_pids "$NEW"); do [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$DIR/web" ] && SPARE_FROM_DIR=1; done
[ "$(systemctl show -p ActiveState --value "dazl-prod@$NEW.service" 2>/dev/null)" != inactive ] && [ "$(sed -n 's/^DAZL_RELEASE=//p' "$PORTCONF/$NEW.conf" 2>/dev/null)" = "$DIR" ] && SPARE_FROM_DIR=1
if [ $SPARE_FROM_DIR = 1 ]; then stop_port "$NEW" "its release dir is about to be replaced" || die "could not free :$NEW; prod untouched"; fi
for p in $(ss -l -t -n -p -H | grep -oP 'pid=\K[0-9]+' | sort -u); do
  c=$(readlink "/proc/$p/cwd" 2>/dev/null || true); [[ $c == "$DIR" || $c == "$DIR"/* ]] && die "$DIR is in use by pid $p (not the spare port); refusing"
done
as_app rm -rf -- "$DIR"
as_app git clone -q --filter=blob:none "$REPO_URL" "$DIR" || die "git clone failed; prod untouched"
as_app git -C "$DIR" checkout -q "$SHA" || die "git checkout $SHA failed; prod untouched"
as_app bash "$PULL" extract "$SHA" "$DIR/web" "$LIVE_WEB" "$PROD_MIN_FREE_BYTES" 0 || { as_app rm -rf -- "$DIR"; die "the prebuilt build did not unpack; prod untouched"; }
as_app bash -c 'umask 077; cat > "$1"' _ "$DIR/.release.env" < "$OPS/prod.env.next"
log "3/10 release ready in $DIR (no build ran on this box)"

# --- 4. migrate
as_app bash -c 'cd "$1/web" && set -a && . "$1/.release.env" && set +a && npm run -s db:migrate' _ "$DIR" 8>&- || die "migration failed; prod untouched (backup $BK)"
log "4/10 migrate done"

# --- memory preflight (a new next-server needs ~150-250 MB)
avail=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo)
[ "$avail" -ge "$MIN_AVAIL_MB" ] || die "only $avail MB RAM available (< $MIN_AVAIL_MB): not starting a second release; prod untouched. Free memory (--stop-port on the old rollback target, or stop orphans) and retry"

# --- 5. free the spare port (never the live one)
stop_port "$NEW" "spare port for $S8" || die "could not free the spare :$NEW; prod untouched"
if [ -f "$STATE" ] && grep -qx "PREV_PORT=$NEW" "$STATE"; then NEW_SHA=; NEW_PORT=; . "$STATE"; write_state none "" "${NEW_SHA:-}" "${NEW_PORT:-}"; fi
log "5/10 spare :$NEW free"

# --- 6. start the supervised unit
printf 'DAZL_RELEASE=%s\n' "$DIR" > "$PORTCONF/$NEW.conf.tmp"; chmod 644 "$PORTCONF/$NEW.conf.tmp"; mv -f "$PORTCONF/$NEW.conf.tmp" "$PORTCONF/$NEW.conf"
systemctl reset-failed "dazl-prod@$NEW.service" 2>/dev/null || true
systemctl start "dazl-prod@$NEW.service" || { journalctl -u "dazl-prod@$NEW.service" -n 30 --no-pager || true; die "dazl-prod@$NEW did not start; NOT switching (dazl.ai still on :$LIVE)"; }
MAINPID=; c=; NEW_INST=; ok=0
for _ in $(seq 1 "${PROD_HEALTH_TRIES:-90}"); do
  MAINPID=$(systemctl show -p MainPID --value "dazl-prod@$NEW.service")
  read -r c NEW_INST < <(health "http://127.0.0.1:$NEW")
  if [ "$c" = "$SHA" ]; then
    lp=$(port_pids "$NEW" | head -1)
    if [ -n "$lp" ] && [ "$(unit_of "$lp")" = "dazl-prod@$NEW.service" ]; then ok=1; break; fi
    log "WARNING: :$NEW answers $SHA but the listener (pid ${lp:-?}, $(unit_of "${lp:-0}")) is not dazl-prod@$NEW"
  fi
  sleep "${PROD_HEALTH_SLEEP:-2}"
done
if [ $ok != 1 ]; then
  journalctl -u "dazl-prod@$NEW.service" -n 30 --no-pager || true
  stop_port "$NEW" "failed health" || true
  die "dazl-prod@$NEW did not report $SHA from its own process; NOT switching (dazl.ai still on :$LIVE)"
fi
log "6/10 dazl-prod@$NEW.service active (MainPID $MAINPID), /api/health = $SHA, instance $NEW_INST ($(( $(date +%s) - T0 ))s since start)"

# --- 7. local smoke on the spare
for pth in $SMOKE_PATHS; do
  code=$(http_code "http://127.0.0.1:$NEW$pth")
  [ "$code" = 200 ] || { stop_port "$NEW" "failed local smoke" || true; die "local smoke $pth on :$NEW -> $code; NOT switching (dazl.ai still on :$LIVE)"; }
done
log "7/10 local smoke on :$NEW ok [$SMOKE_PATHS]"

# --- 8+9. switch, public smoke, stability window; auto-rollback on any failure
fail_back() {
  log "AUTO-ROLLBACK: $1"
  if switch_caddy "$LIVE" && public_smoke "${OLD_SHA:-$SHA}" "$OLD_INST"; then
    log "dazl.ai is back on :$LIVE (${OLD_SHA:-?}, instance $OLD_INST)"
    stop_port "$NEW" "failed after the switch; Caddy is back on :$LIVE" || true
  else
    log "CRITICAL: switching back to :$LIVE did not verify; leaving BOTH releases running. Check: deploy-prod.sh --status"
  fi
  die "deploy of $SHA failed after the switch and was rolled back ($1)"
}
switch_caddy "$NEW" || { stop_port "$NEW" "caddy switch failed" || true; die "caddy switch failed; dazl.ai still on :$LIVE"; }
TSW=$(date +%s)
log "8/10 switched Caddy to :$NEW"
public_smoke "$SHA" "$NEW_INST" || fail_back "public smoke failed"
NR0=$(systemctl show -p NRestarts --value "dazl-prod@$NEW.service")
# stability window: checked every second, so a crash of the new release switches back within ~1-2 s, not at the end
for _ in $(seq 1 "$STABLE_S"); do
  sleep 1
  unit_active "$NEW" || fail_back "dazl-prod@$NEW is no longer active"
  [ "$(systemctl show -p NRestarts --value "dazl-prod@$NEW.service")" = "$NR0" ] || fail_back "dazl-prod@$NEW restarted during the stability window"
  [ "$(systemctl show -p MainPID --value "dazl-prod@$NEW.service")" = "$MAINPID" ] || fail_back "dazl-prod@$NEW changed MainPID (its process died)"
done
public_smoke "$SHA" "$NEW_INST" || fail_back "public smoke failed after the ${STABLE_S}s stability window"
log "9/10 public smoke + ${STABLE_S}s stability ok"

# --- 10. record, boot enablement, prune (the old release keeps running for an instant rollback)
mv -f "$OPS/prod.env.next" "$OPS/prod.env"
if [ -n "$OLD_SHA" ]; then write_state "$LIVE" "$OLD_SHA" "$SHA" "$NEW"; else write_state none "" "$SHA" "$NEW"; fi
set_boot "$NEW"
if [ "$PRUNE" = 1 ]; then
  keep=" $DIR ${LIVE_WEB%/web} "
  cwds=$(for p in $(ss -l -t -n -p -H | grep -oP 'pid=\K[0-9]+' | sort -u); do readlink "/proc/$p/cwd" 2>/dev/null || echo '?'; done)
  if printf '%s\n' "$cwds" | grep -qxF '?'; then log "not pruning: a listener's directory cannot be read"
  else
    for d in "$RELEASE_ROOT"/dazl-*-prod; do
      [ -d "$d" ] && [ ! -L "$d" ] || continue
      case "$keep" in *" $d "*) continue ;; esac
      printf '%s\n' "$cwds" | grep -q -- "^$d" && continue
      grep -qxF "DAZL_RELEASE=$d" "$PORTCONF"/*.conf 2>/dev/null && continue
      [ "$(stat -c %U -- "$d")" != root ] || continue
      log "removing unused release $d"; as_user "$(stat -c %U -- "$d")" rm -rf -- "$d" 2>/dev/null || log "could not remove all of $d"
    done
  fi
fi
log "memory after: $(free -m | awk '/^Mem/{print "used "$3" MB, available "$7" MB"} /^Swap/{print "swap used "$3" MB"}' | tr '\n' ' ')"
log "10/10 DONE: dazl.ai now $SHA on :$NEW (dazl-prod@$NEW, instance $NEW_INST). Switch at +$(( TSW - T0 ))s, total $(( $(date +%s) - T0 ))s. Previous ${OLD_SHA:-?} still running on :$LIVE: 'deploy-prod.sh --rollback' to switch back."
