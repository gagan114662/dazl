#!/usr/bin/env bash
# Production deploy for dazl.ai (web/docs/DEPLOY.md, "Deploying a prebuilt release"), run by the ops door as root.
#   deploy-prod.sh <40-hex sha>   check out sha's source in $RELEASE_ROOT/dazl-<sha8>-prod, unpack its PREBUILT build
#                                 (ops/prod/pull-release.sh: built on GitHub, verified here; the box never runs npm ci,
#                                 tsc or next build), back up the DB, migrate, start it on the spare port (3104/3105), wait
#                                 for /api/health = sha, switch Caddy, verify publicly. The old process keeps running, so
#                                 rollback is instant; old release directories beyond live + previous are removed.
#   deploy-prod.sh --rollback     point Caddy back at the previous port (from $STATE), after checking it still answers.
# Disk: refuses unless at least $MIN_FREE_BYTES (3 GiB) stays free after the downloads and the unpacked release.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CADDY=${PROD_CADDYFILE:-/etc/caddy/Caddyfile}
OPS=${PROD_OPS_DIR:-/etc/dazl-ops}
STATE=$OPS/prod-state
DB=${PROD_DB:-/home/ubuntu/dazl-data/dazl-pr16.db}
RELEASE_ROOT=${PROD_RELEASE_ROOT:-/home/ubuntu}
BACKUPS=${PROD_BACKUP_DIR:-/home/ubuntu/dazl-prod-backups}
APP_USER=${PROD_APP_USER:-ubuntu}
RUN_ENV=${PROD_RUN_ENV:-/home/ubuntu/dazl-pr16-run.env}
REPO_URL=${PROD_REPO_URL:-https://github.com/gagan114662/dazl.git}
PUBLIC_URL=${PROD_PUBLIC_URL:-https://dazl.ai}
export PROD_MIN_FREE_BYTES=${PROD_MIN_FREE_BYTES:-3221225472}
PULL=${PROD_PULL_RELEASE:-$HERE/pull-release.sh}
log() { echo "$(date -Is) $*"; }
as_app() { if [ "$(id -un)" = "$APP_USER" ]; then "$@"; else sudo -u "$APP_USER" "$@"; fi; }
health_sha() { curl -s "$1/api/health" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("commit",""))' 2>/dev/null || true; }

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

if [ "${1:-}" = "--rollback" ]; then
  [ -f "$STATE" ] || { log "no previous deploy recorded"; exit 1; }
  . "$STATE"
  cur=$(live_port)
  log "rollback: dazl.ai $cur -> $PREV_PORT"
  curl -sf "http://127.0.0.1:$PREV_PORT/api/health" >/dev/null || { log "previous port $PREV_PORT is not answering; refusing"; exit 1; }
  switch_caddy "$PREV_PORT"
  printf 'PREV_PORT=%s\nPREV_SHA=%s\nNEW_SHA=%s\n' "$cur" "$NEW_SHA" "$PREV_SHA" > "$STATE.tmp"; mv "$STATE.tmp" "$STATE"
  sleep 2; curl -s "$PUBLIC_URL/api/health"; echo; exit 0
fi

SHA=${1:?usage: deploy-prod.sh <40-hex sha> | --rollback}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { log "not a full commit: $SHA"; exit 1; }
S8=${SHA:0:8}
DIR=$RELEASE_ROOT/dazl-$S8-prod
LIVE=$(live_port)
NEW=$([ "$LIVE" = 3104 ] && echo 3105 || echo 3104)
LIVE_PID=$(ss -ltnpH "sport = :$LIVE" | grep -oP 'pid=\K[0-9]+' | head -1)
LIVE_WEB=$(readlink "/proc/$LIVE_PID/cwd" 2>/dev/null || true)
log "live port $LIVE (pid $LIVE_PID, ${LIVE_WEB:-unknown dir}), new port $NEW, sha $SHA"
[ "$(df --output=avail -B1 "$RELEASE_ROOT" | tail -1)" -gt "$PROD_MIN_FREE_BYTES" ] || { log "less than $PROD_MIN_FREE_BYTES bytes free; refusing"; exit 1; }

# 1. the new release's environment = exactly the live process's environment, with the new port (shell-quoted)
python3 - "$LIVE_PID" > "$OPS/prod.env.next" <<'PY'
import shlex, sys
for kv in open(f'/proc/{sys.argv[1]}/environ', 'rb').read().split(b'\0'):
    if b'=' not in kv:
        continue
    k, v = kv.decode(errors='replace').split('=', 1)
    if k in ('PORT', '_', 'PWD', 'OLDPWD', 'SHLVL') or not k.replace('_', 'a').isalnum():
        continue
    print(f'{k}={shlex.quote(v)}')
PY
grep -E '^[A-Z][A-Z0-9_]*=' "$RUN_ENV" >> "$OPS/prod.env.next" 2>/dev/null || true
chmod 600 "$OPS/prod.env.next"

# 2. the release: source checked out as the app user, the build PREBUILT on GitHub (never built here)
if [ ! -f "$DIR/web/.next/BUILD_ID" ] || [ "$(cat "$DIR/.ops-sha" 2>/dev/null)" != "$SHA" ]; then
  if [ -d "$DIR" ] && listener_cwds | grep -q "^$DIR"; then
    if [ -f "$DIR/web/.next/BUILD_ID" ]; then log "$DIR is live and complete: reusing it"; echo "$SHA" > "$DIR/.ops-sha"
    else log "$DIR is in use by a live process but incomplete; refusing"; exit 1; fi
  else
    bash "$PULL" fetch "$SHA"  # verified download + disk floor; fails before anything on the box changes
    rm -rf "$DIR"
    as_app git clone -q --filter=blob:none "$REPO_URL" "$DIR"
    as_app git -C "$DIR" checkout -q "$SHA"
    as_app bash "$PULL" extract "$SHA" "$DIR/web" "$LIVE_WEB" || { rm -rf "$DIR"; log "the prebuilt build of $SHA did not unpack; prod untouched"; exit 1; }
    echo "$SHA" | as_app tee "$DIR/.ops-sha" >/dev/null
  fi
fi

# 3. back up the DB, then migrate (a script run, no build)
mkdir -p "$BACKUPS"
BK=$BACKUPS/predeploy-$S8-$(date +%Y%m%dT%H%M%S).db
sqlite3 "$DB" ".backup '$BK'"
log "db backup $BK ($(stat -c %s "$BK") bytes)"
( cd "$DIR/web" && set -a && . "$OPS/prod.env.next" && set +a && npm run -s db:migrate ) || { log "migration failed; prod untouched (backup at $BK)"; exit 1; }

# 4. start on the spare port (stop anything stale there first)
OLD_ON_NEW=$(ss -ltnpH "sport = :$NEW" | grep -oP 'pid=\K[0-9]+' | head -1 || true)
[ -n "$OLD_ON_NEW" ] && { log "stopping stale process $OLD_ON_NEW on $NEW"; kill "$OLD_ON_NEW" || true; sleep 3; }
( cd "$DIR/web" && set -a && . "$OPS/prod.env.next" && set +a && PORT=$NEW nohup npx next start -p "$NEW" > "/var/tmp/dazl-prod-$S8.log" 2>&1 & )
c=
for _ in $(seq 1 "${PROD_HEALTH_TRIES:-90}"); do c=$(health_sha "http://127.0.0.1:$NEW"); [ "$c" = "$SHA" ] && break; sleep "${PROD_HEALTH_SLEEP:-2}"; done
[ "$c" = "$SHA" ] || { log "new release did not report $SHA on :$NEW; NOT switching (dazl.ai still on :$LIVE)"; tail -30 "/var/tmp/dazl-prod-$S8.log" || true; exit 1; }

# 5. switch, verify publicly, record rollback state
OLD_SHA=$(health_sha "http://127.0.0.1:$LIVE")
switch_caddy "$NEW"
sleep "${PROD_SWITCH_SLEEP:-3}"
pub=$(health_sha "$PUBLIC_URL")
if [ "$pub" != "$SHA" ]; then log "public health shows '$pub', not $SHA: rolling back"; switch_caddy "$LIVE"; exit 1; fi
mv "$OPS/prod.env.next" "$OPS/prod.env"
printf 'PREV_PORT=%s\nPREV_SHA=%s\nNEW_SHA=%s\n' "$LIVE" "$OLD_SHA" "$SHA" > "$STATE"

# 6. disk: keep the live release and the previous one (the instant rollback target); remove older release directories
#    that no listener runs from
keep=" $DIR ${LIVE_WEB%/web} "
for d in "$RELEASE_ROOT"/dazl-*-prod; do
  [ -d "$d" ] || continue
  case "$keep" in *" $d "*) continue ;; esac
  listener_cwds | grep -q "^$d" && continue
  log "removing old release $d"; rm -rf -- "$d"
done
log "DONE: dazl.ai now $SHA on :$NEW. Previous $OLD_SHA still running on :$LIVE (deploy-prod.sh --rollback to switch back)."
