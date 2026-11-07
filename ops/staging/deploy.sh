#!/usr/bin/env bash
# Staging deploy (docs/STAGING.md). Run by dazl-staging-deploy.timer every 2 minutes, as root. When origin/main has a
# new commit it:
#   1. checks the staging env file is safe (check_env: staging only, never production's database, Stripe test mode)
#   2. checks the disk: a new release is started only if free space minus its estimated size stays above the floor
#      (MIN_FREE_BYTES, 2 GiB by default), and the build is stopped if free space falls to the floor while it runs
#   3. builds the commit in its own release directory as the service user, with the env file's values passed in by
#      root (the file itself stays root-only, mode 600); the build does NOT touch the database
#   3b. (#908) stops the service (no writes from here), takes a verified WAL-safe recovery point of DB_PATH bound to the
#      live release (ops/staging/recovery_point.py, in a root-only directory outside anything the service account can
#      write; fail closed: no recovery point, no migration, old release restarted), records a root-only pending marker
#      (which recovery point, its manifest checksum, the previous release), then migrates and seeds, switches `current`,
#      restarts the service. The deploy commits when the new release is healthy and the marker is removed.
#   0. before anything else, a pending marker left by a deploy that was killed or whose restore failed is finished: the
#      service is stopped, THAT recovery point (checked against its recorded checksum) is restored, and the previous
#      release restarted. A retry never takes a new recovery point over a migrated database while one is pending.
#   4. waits for /api/health to answer ok (every configured database reachable) with the new commit (the smoke check,
#      ops/health-smoke.mjs); otherwise stops it, restores the recovery point (the matching pre-migration database) and
#      only then switches back and restarts the previous release. A restore that cannot be verified leaves the service
#      DOWN rather than running old code against a migrated database. Writes made by the failed release before it was
#      rolled back are discarded with it; nothing else could write while the service was stopped.
# A release that fails at any step is deleted at once. Complete releases are marked; the live one and the two before
# it are kept, older ones are deleted. node_modules is hard-linked from the live release when package-lock.json is
# unchanged, so a release then costs about the size of its build output.
# Usage: deploy.sh                    deploy origin/main if it changed
#        deploy.sh --check-env FILE   only validate an env file (exit 0 = safe); values are never printed
set -euo pipefail

ROOT=${STAGING_ROOT:-/srv/dazl-staging}
ENV_FILE=${STAGING_ENV_FILE:-/etc/dazl-staging/env}
PORT=${STAGING_PORT:-3200}
SERVICE=${STAGING_SERVICE:-dazl-staging.service}
RUN_AS=${STAGING_USER:-dazl-staging}
REPO_URL=${STAGING_REPO_URL:-https://github.com/gagan114662/dazl.git}
RESTART=${STAGING_RESTART:-systemctl restart $SERVICE}
MIN_FREE_BYTES=${MIN_FREE_BYTES:-2147483648}
# Headroom kept above the floor while building: the build is stopped, and a finished release is not put live, once free
# space falls below MIN_FREE_BYTES + DISK_RESERVE_BYTES, so the protected floor itself is never crossed.
DISK_RESERVE_BYTES=${DISK_RESERVE_BYTES:-268435456}
WATCH_INTERVAL=${STAGING_WATCH_INTERVAL:-0.5}
# used when there is no live release to measure: node_modules plus build output, measured at about 1.1 GB
FIRST_RELEASE_BYTES=${FIRST_RELEASE_BYTES:-1200000000}
# Production's database: given as its path, or read from production's env file. Fail closed when neither is known.
PROD_DB_PATH=${PROD_DB_PATH:-}
PROD_ENV_FILE=${PROD_ENV_FILE:-}
# The build, run in the release's web/ directory as the service user with the env file's values. Tests replace it.
BUILD=${STAGING_BUILD:-'{ [ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error; } && NODE_OPTIONS=--max-old-space-size=2048 nice -n 10 npx next build && rm -rf .next/cache'}
# The schema change and seed (#908): run only after the service is stopped and a verified recovery point exists. Tests replace it.
MIGRATE=${STAGING_MIGRATE:-'npm run -s db:migrate && node --experimental-strip-types --no-warnings scripts/staging-seed.mts'}
STOP=${STAGING_STOP:-systemctl stop $SERVICE}
# The recovery helper, installed beside this script in a root-owned directory (docs/STAGING.md), and the root-only directory
# recovery points live in: outside STAGING_ROOT (the service account's home) so that account cannot rename or replace them.
RECOVERY=${STAGING_RECOVERY:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/recovery_point.py}
RROOT=${STAGING_RECOVERY_ROOT:-/var/lib/dazl-staging-recovery}
HEALTH_TRIES=${STAGING_HEALTH_TRIES:-60}
# Low-disk alerts: OPS_ALERT_WEBHOOK_URL from the staging env file (https), or STAGING_ALERT_CMD (tests). One alert per
# reason per STAGING_ALERT_EVERY_S while the condition lasts; every skip is still logged to the journal.
ALERT_CMD=${STAGING_ALERT_CMD:-}
ALERT_EVERY_S=${STAGING_ALERT_EVERY_S:-3600}

log() { echo "staging-deploy: $*"; }
fail() { echo "staging-deploy: $*" >&2; exit 1; }
val() { sed -n "s/^\(export \)\{0,1\}$1=//p" "$2" | tail -n 1 | sed "s/^[\"']//; s/[\"']$//"; }

# Staging Gmail (issue #413): stubbed unless DAZL_STAGING_REAL_GMAIL=1. Real mode needs its own staging-only OAuth client
# (GMAIL_STAGING_CLIENT_ID/SECRET, both) and an owner-inbox allowlist (DAZL_STAGING_GMAIL_ALLOWLIST: exact addresses, no
# wildcards or domains). Credentials without the flag, or the flag without the full config, refuse the deploy.
check_gmail_transport() {
  local f=$1 flag id secret allow a
  flag=$(val DAZL_STAGING_REAL_GMAIL "$f"); id=$(val GMAIL_STAGING_CLIENT_ID "$f"); secret=$(val GMAIL_STAGING_CLIENT_SECRET "$f"); allow=$(val DAZL_STAGING_GMAIL_ALLOWLIST "$f")
  if [ "$flag" != 1 ]; then
    [ -z "$flag" ] || [ "$flag" = 0 ] || fail "env: DAZL_STAGING_REAL_GMAIL must be 1 or unset"
    [ -z "$id$secret$allow" ] || fail "env: Gmail credentials/allowlist on staging need DAZL_STAGING_REAL_GMAIL=1 (Gmail is stubbed)"
    return 0
  fi
  [ -n "$id" ] && [ -n "$secret" ] || fail "env: GMAIL_STAGING_CLIENT_ID and GMAIL_STAGING_CLIENT_SECRET go together and are required with DAZL_STAGING_REAL_GMAIL=1"
  case "$id" in *.apps.googleusercontent.com) ;; *) fail "env: GMAIL_STAGING_CLIENT_ID is not a Google OAuth client id";; esac
  [ -n "$allow" ] || fail "env: DAZL_STAGING_GMAIL_ALLOWLIST is required with DAZL_STAGING_REAL_GMAIL=1"
  local IFS=,
  for a in $allow; do
    a=$(printf '%s' "$a" | tr -d ' ')
    case "$a" in *'*'*|'') fail "env: DAZL_STAGING_GMAIL_ALLOWLIST holds exact addresses only";; esac
    printf '%s' "$a" | grep -Eq '^[^@<>;" ]+@[^@<>;" ]+[.][^@<>;" ]+$' || fail "env: DAZL_STAGING_GMAIL_ALLOWLIST entry is not an email address"
  done
  unset IFS
  for k in GOOGLE_CLIENT_ID GOOGLE_SIGNIN_CLIENT_ID GMAIL_STAGING_CLIENT_ID; do v=; [ -z "$PROD_ENV_FILE" ] || v=$(val "$k" "$PROD_ENV_FILE"); [ -z "$v" ] || [ "$v" != "$id" ] || fail "env: the staging Gmail client is production's Google client"; done
  for k in GOOGLE_CLIENT_SECRET GOOGLE_SIGNIN_CLIENT_SECRET GMAIL_STAGING_CLIENT_SECRET; do v=; [ -z "$PROD_ENV_FILE" ] || v=$(val "$k" "$PROD_ENV_FILE"); [ -z "$v" ] || [ "$v" != "$secret" ] || fail "env: the staging Gmail client secret is production's"; done
  sid=$(val GOOGLE_SIGNIN_CLIENT_ID "$f"); [ -z "$sid" ] || [ "$sid" != "$id" ] || fail "env: the staging Gmail client must differ from the sign-in client"
}

check_env() {
  local f=$1
  [ -f "$f" ] || fail "env file $f not found"
  [ "$(val DAZL_ENV "$f")" = staging ] || fail "env: DAZL_ENV must be staging"
  [ -z "$(val DATABASE_URL "$f")" ] || fail "env: no DATABASE_URL on staging (its store is its own SQLite file)"
  case "$(val STRIPE_SECRET_KEY "$f")" in sk_test_*|rk_test_*|'') ;; *) fail "env: STRIPE_SECRET_KEY must be a test-mode key";; esac
  case "$(val PUBLIC_BASE_URL "$f")" in https://staging.*) ;; *) fail "env: PUBLIC_BASE_URL must be the staging URL";; esac
  [ -z "$(val GOOGLE_CLIENT_SECRET "$f")" ] && [ -z "$(val GOOGLE_CLIENT_ID "$f")" ] || fail "env: no Google credentials on staging under GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (they disable staging sign-in; real staging Gmail uses GMAIL_STAGING_*)"
  check_gmail_transport "$f"
  check_signin_client "$f"
  local db; db=$(val DB_PATH "$f")
  [ -n "$db" ] || fail "env: DB_PATH is required"
  case "$db" in /*) ;; *) fail "env: DB_PATH must be absolute";; esac
  # production's database, by its canonical path: symlinks, .. and aliases resolved on both sides
  local prod=$PROD_DB_PATH
  if [ -z "$prod" ] && [ -n "$PROD_ENV_FILE" ]; then [ -r "$PROD_ENV_FILE" ] || fail "PROD_ENV_FILE not readable"; prod=$(val DB_PATH "$PROD_ENV_FILE"); fi
  [ -n "$prod" ] || fail "production's DB_PATH is unknown: set PROD_DB_PATH or PROD_ENV_FILE for the deploy"
  local sdb pdb sdir pdir
  sdb=$(realpath -m -- "$db"); pdb=$(realpath -m -- "$prod"); sdir=$(dirname "$sdb"); pdir=$(dirname "$pdb")
  [ "$sdb" != "$pdb" ] || fail "env: DB_PATH is the production database"
  case "$sdir/" in "$pdir/"*) fail "env: DB_PATH is inside the production database's directory";; esac
  case "$pdir/" in "$sdir/"*) fail "env: production's database is inside the staging DB_PATH's directory";; esac
  # the same file under another name (a hard link): same device and inode
  if [ -e "$sdb" ] && [ -e "$pdb" ] && [ "$(stat -Lc '%d:%i' -- "$sdb")" = "$(stat -Lc '%d:%i' -- "$pdb")" ]; then fail "env: DB_PATH is the production database (same file)"; fi
  return 0
}

# Sign in with Google on staging: only a dedicated, identity-only OAuth client (GOOGLE_SIGNIN_CLIENT_ID/SECRET, both or
# neither), never production's. Its id and secret must differ from every Google client in production's env file, so
# that file must be readable whenever a sign-in client is configured (fail closed). Values are never printed.
check_signin_client() {
  local f=$1 id secret
  id=$(val GOOGLE_SIGNIN_CLIENT_ID "$f"); secret=$(val GOOGLE_SIGNIN_CLIENT_SECRET "$f")
  [ -z "$id" ] && [ -z "$secret" ] && return 0
  [ -n "$id" ] && [ -n "$secret" ] || fail "env: GOOGLE_SIGNIN_CLIENT_ID and GOOGLE_SIGNIN_CLIENT_SECRET go together"
  case "$id" in *.apps.googleusercontent.com) ;; *) fail "env: GOOGLE_SIGNIN_CLIENT_ID is not a Google OAuth client id";; esac
  [ -n "$PROD_ENV_FILE" ] && [ -r "$PROD_ENV_FILE" ] || fail "env: a staging sign-in client needs PROD_ENV_FILE to prove it is not production's"
  local k v
  for k in GOOGLE_CLIENT_ID GOOGLE_SIGNIN_CLIENT_ID; do v=$(val "$k" "$PROD_ENV_FILE"); [ -z "$v" ] || [ "$v" != "$id" ] || fail "env: the staging sign-in client is production's Google client"; done
  for k in GOOGLE_CLIENT_SECRET GOOGLE_SIGNIN_CLIENT_SECRET; do v=$(val "$k" "$PROD_ENV_FILE"); [ -z "$v" ] || [ "$v" != "$secret" ] || fail "env: the staging sign-in client secret is production's"; done
  return 0
}

if [ "${1:-}" = --check-env ]; then check_env "${2:?usage: deploy.sh --check-env FILE}"; echo "env ok"; exit 0; fi

check_env "$ENV_FILE"
# Staging's own directory must not be, contain, or sit inside production's data directory: everything this script
# deletes (failed releases, old staging releases) is under it, so production data and production rollbacks can never be.
prod_dir=$(dirname "$(realpath -m -- "${PROD_DB_PATH:-$(val DB_PATH "$PROD_ENV_FILE")}")"); root_real=$(realpath -m -- "$ROOT")
[ "$root_real" != / ] || fail "STAGING_ROOT must not be /"
case "$root_real/" in "$prod_dir/"*) fail "STAGING_ROOT $ROOT is inside production's data directory";; esac
case "$prod_dir/" in "$root_real/"*) fail "STAGING_ROOT $ROOT contains production's data directory";; esac
mkdir -p "$ROOT/releases"
exec 9>"$ROOT/.deploy.lock"; flock -n 9 || { log "another deploy is running"; exit 0; }
staging_db=$(val DB_PATH "$ENV_FILE")

# Preflight (#908), before anything is stopped: the recovery helper is installed, owned by root (or by the user running the
# deploy, in tests) and writable by no one else, as is its directory; the recovery root is private. Otherwise nothing runs.
for f in "$RECOVERY" "$(dirname "$RECOVERY")"; do
  [ -e "$f" ] || fail "the recovery helper $RECOVERY is not installed (install ops/staging/recovery_point.py beside deploy.sh, docs/STAGING.md); nothing stopped or changed"
  o=$(stat -Lc %u "$f"); m=$(stat -Lc %a "$f")
  { [ "$o" = 0 ] || [ "$o" = "$(id -u)" ]; } && [ $(( 8#$m & 8#022 )) = 0 ] || fail "the recovery helper or its directory ($f) is writable by another user; nothing stopped or changed"
done
command -v python3 >/dev/null || fail "python3 is required for the recovery point; nothing stopped or changed"
[ -d "$RROOT" ] || install -d -m 700 "$RROOT"
python3 "$RECOVERY" check-root --dir "$RROOT" || fail "the recovery root $RROOT is not private to root; nothing stopped or changed"
pending="$RROOT/pending"
pval() { [ -e "$pending" ] || return 0; sed -n "s/^$1=//p" "$pending" | tail -n 1; }
write_pending() { # rp manifest-sha prev new: written whole, fsynced, then renamed into place and the directory fsynced
  local t="$RROOT/.pending.tmp"
  printf 'rp=%s\nmanifest=%s\nprev=%s\nnew=%s\n' "$1" "$2" "$3" "$4" > "$t" && sync "$t" && mv -f "$t" "$pending" && sync "$RROOT"
}
clear_pending() { rm -f "$pending"; sync "$RROOT"; }
# The smoke check: /api/health answers 200, ok, with commit $1, run with that release's own ops/health-smoke.mjs. A
# release from before the smoke check existed (only ever a rollback target) is checked for its commit alone.
healthy() {
  local smoke="$ROOT/releases/$1/ops/health-smoke.mjs"
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if [ -f "$smoke" ]; then node "$smoke" "http://127.0.0.1:$PORT" "$1" 2>/dev/null && return 0
    else curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q "\"commit\":\"$1\"" && return 0; fi
    sleep 2
  done
  [ -f "$smoke" ] && node "$smoke" "http://127.0.0.1:$PORT" "$1" >&2 || true # the last reason, in the journal
  return 1
}

# 0. An earlier deploy left a pending marker: it was killed after its recovery point, or its restore failed. Finish that
# restore first, from THAT recovery point (refused if it is not the one recorded), and put the previous release back.
if [ -e "$pending" ]; then
  p_rp=$(pval rp); p_m=$(pval manifest); p_prev=$(pval prev); p_new=$(pval new)
  log "an interrupted deploy of ${p_new:-?} left a pending recovery point; restoring it before anything else"
  $STOP 9>&- || fail "interrupted deploy of $p_new: could not stop the service to restore the database: NO VERIFIED STAGING STATE (recovery point kept at $p_rp)"
  python3 "$RECOVERY" restore --db "$staging_db" --dir "$p_rp" --expect-manifest "$p_m" \
    || fail "interrupted deploy of $p_new: database restore failed: NO LIVE STAGING SERVICE (old code not started; recovery point kept at $p_rp)"
  clear_pending
  [ -n "$p_new" ] && [ "$ROOT/releases/$p_new" != "$p_prev" ] && rm -rf "$ROOT/releases/$p_new"
  if [ -n "$p_prev" ] && [ -d "$p_prev" ]; then
    ln -sfn "$p_prev" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$(basename "$p_prev")" > "$ROOT/release.env"
    $RESTART 9>&- && healthy "$(basename "$p_prev")" && fail "recovered the interrupted deploy of $p_new: database restored, $(basename "$p_prev") is live again"
    fail "recovered the interrupted deploy of $p_new: database restored, but $(basename "$p_prev") did not come up healthy: NO LIVE STAGING SERVICE"
  fi
  rm -f "$ROOT/current" "$ROOT/release.env"
  fail "recovered the interrupted first deployment of $p_new: database restored, NO LIVE STAGING SERVICE"
fi
as() { if [ "$(id -un)" = "$RUN_AS" ]; then "$@"; else runuser -u "$RUN_AS" -- "$@"; fi; }
free_bytes() { df -B1 --output=avail "$ROOT" | tail -n 1 | tr -d ' '; }
alert() { # reason, free bytes, bytes needed (0 when only the floor matters), message
  local reason=$1 free=$2 need=$3 msg=$4 stamp="$ROOT/.alert-$1" now
  log "ALERT $reason: $msg"
  now=$(date +%s)
  if [ -e "$stamp" ] && [ $(( now - $(stat -c %Y "$stamp") )) -lt "$ALERT_EVERY_S" ]; then log "(alert $reason already sent within ${ALERT_EVERY_S}s)"; return 0; fi
  touch "$stamp"
  local body
  body=$(printf '{"level":"warn","type":"staging_deploy","reason":"%s","free_bytes":%s,"needed_bytes":%s,"floor_bytes":%s,"host":"%s"}' "$reason" "$free" "$need" "$MIN_FREE_BYTES" "$(hostname -s 2>/dev/null || echo unknown)")
  if [ -n "$ALERT_CMD" ]; then $ALERT_CMD "$body" || log "alert command failed"; return 0; fi
  local url; url=$(val OPS_ALERT_WEBHOOK_URL "$ENV_FILE")
  case "$url" in
    https://*) curl -fsS -m 10 -H 'content-type: application/json' -d "$body" "$url" >/dev/null || log "alert webhook failed" ;;
    *) log "no alert destination: set OPS_ALERT_WEBHOOK_URL (https) in $ENV_FILE" ;;
  esac
}
disk_ok() { rm -f "$ROOT"/.alert-low_disk*; } # back above the floor: the next low-disk event alerts at once

# Below the floor already: skip this run before fetching or building anything.
avail=$(free_bytes)
if [ "$avail" -lt "$MIN_FREE_BYTES" ]; then
  alert low_disk "$avail" 0 "skipped: $avail bytes free, below the floor of $MIN_FREE_BYTES; nothing fetched, built or deleted"
  exit 0
fi

# leftovers of an interrupted deploy (no completion mark) go first
live_now=; [ -L "$ROOT/current" ] && live_now=$(readlink -f "$ROOT/current")
for d in "$ROOT"/releases/*/; do [ -d "$d" ] && [ ! -e "$d/.complete" ] && [ "$live_now" != "$(readlink -f "$d")" ] && rm -rf "$d"; done

[ -d "$ROOT/repo/.git" ] || as git clone -q --no-checkout "$REPO_URL" "$ROOT/repo"
as git -C "$ROOT/repo" fetch -q origin main
new=$(as git -C "$ROOT/repo" rev-parse origin/main)
cur=$(cat "$ROOT/current-sha" 2>/dev/null || true)
[ "$new" != "$cur" ] || exit 0

# the live release: only when `current` is a symlink (readlink -f of a missing path returns the path itself)
live=; [ -L "$ROOT/current" ] && live=$(readlink -f "$ROOT/current")
reuse=0
if [ -n "$live" ] && [ -d "$live/web/node_modules" ] && as git -C "$ROOT/repo" diff --quiet "$cur" "$new" -- web/package-lock.json 2>/dev/null; then reuse=1; fi
if [ -n "$live" ] && [ -d "$live/web" ]; then
  est=$(du -sb --exclude=node_modules "$live/web" | cut -f1)
  [ $reuse = 1 ] || est=$(( est + $(du -sb "$live/web/node_modules" | cut -f1) ))
else est=$FIRST_RELEASE_BYTES; fi
avail=$(free_bytes)
if [ $(( avail - est )) -lt $(( MIN_FREE_BYTES + DISK_RESERVE_BYTES )) ]; then
  alert low_disk_for_release "$avail" "$est" "skipped $new: $avail bytes free, a release needs about $est, and the floor is $MIN_FREE_BYTES plus a reserve of $DISK_RESERVE_BYTES; the live release is unchanged"
  exit 0
fi
disk_ok
log "deploying $new (was ${cur:-none}); $avail bytes free, release about $est"

rel="$ROOT/releases/$new"
build_pid=
cleanup() { [ -n "$build_pid" ] && kill -TERM -- "-$build_pid" 2>/dev/null || true; rm -rf "$rel"; }
trap 'cleanup; fail "deploy of $new failed; release removed, the live release is unchanged"' ERR
rm -rf "$rel"; install -d -o "$RUN_AS" -g "$(id -gn "$RUN_AS")" "$rel"
as sh -c "git -C '$ROOT/repo' archive '$new' | tar -x -C '$rel'"
[ $reuse = 1 ] && cp -al "$live/web/node_modules" "$rel/web/node_modules"

# The build runs in its own process group; a watcher stops it if free space falls to the floor plus the reserve.
( set -a; . "$ENV_FILE"; set +a
  exec setsid bash -c 'if [ "$(id -un)" = "$0" ]; then exec "$@"; else exec runuser -u "$0" -- "$@"; fi' "$RUN_AS" \
    bash -c "cd '$rel/web' && echo '$new' > .build-commit && $BUILD" ) &
build_pid=$!
low=0; guard=$(( MIN_FREE_BYTES + DISK_RESERVE_BYTES ))
while kill -0 "$build_pid" 2>/dev/null; do
  if [ "$(free_bytes)" -lt "$guard" ]; then low=1; kill -TERM -- "-$build_pid" 2>/dev/null || true; break; fi
  sleep "$WATCH_INTERVAL"
done
status=0; wait "$build_pid" || status=$?
build_pid=
if [ $low = 1 ]; then
  cleanup
  alert low_disk_during_build "$(free_bytes)" "$est" "stopped the build of $new: free space fell below the floor plus reserve ($guard bytes); its release removed, the live release unchanged"
  fail "free space fell below the floor plus reserve ($guard bytes) during the build; release removed"
fi
[ $status = 0 ] || { cleanup; fail "build or seed of $new failed (exit $status); release removed"; }
# The last word before going live: the build may have ended (and written most) after the watcher's last look.
after=$(free_bytes)
if [ "$after" -lt "$guard" ]; then
  cleanup
  alert low_disk_after_build "$after" "$est" "did not put $new live: $after bytes free after its build, below the floor plus reserve ($guard bytes); its release removed, the live release unchanged"
  fail "free space below the floor plus reserve ($guard bytes) after the build; release removed, live release unchanged"
fi
trap - ERR

# Recovery point, then the schema change (#908). The live service is stopped first so nothing writes between the copy and
# the migration; the copy is verified against its manifest before anything is migrated. No verified copy: no migration.
prev=$live
# A fresh, uniquely named recovery point for this attempt: an earlier one is never reused, overwritten or deleted here (a
# pending one was restored at step 0; older ones are pruned only below, never the pending one).
rp="$RROOT/$new.$(date +%s).$$"
prune_recovery() { # the newest three recovery points are kept, and never the one a pending marker names
  local keep; keep=$(pval rp)
  ls -1dt "$RROOT"/*/ 2>/dev/null | sed 's:/$::' | while read -r d; do [ "$d" = "$keep" ] || echo "$d"; done | tail -n +4 | xargs -r rm -rf || true
}
prune_recovery
# The previous release, unchanged code and database, back up after a refusal before any migration. A first deployment has
# no previous release: returns 1, so nothing reports a restart that did not happen.
restart_prev() {
  [ -n "$prev" ] || return 1
  ln -sfn "$prev" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$(basename "$prev")" > "$ROOT/release.env"
  $RESTART 9>&- && healthy "$(basename "$prev")"
}
if ! $STOP 9>&-; then
  cleanup
  restart_prev && fail "could not stop the service for a recovery point; nothing migrated, release removed, $(basename "$prev") restarted unchanged"
  [ -n "$prev" ] || fail "could not stop the service for a recovery point; nothing migrated, release removed (first deployment: NO LIVE STAGING SERVICE)"
  fail "could not stop the service for a recovery point; nothing migrated, release removed, and $(basename "$prev") did not come back healthy: NO LIVE STAGING SERVICE"
fi
mh=
if ! mh=$(python3 "$RECOVERY" create --db "$staging_db" --dir "$rp" --commit "$(basename "${prev:-none}")") || ! [[ $mh =~ ^[0-9a-f]{64}$ ]]; then
  rm -rf "$rp"; cleanup
  restart_prev && fail "no verified recovery point; nothing migrated, $(basename "$prev") restarted unchanged"
  [ -n "$prev" ] || fail "no verified recovery point on a first deployment; nothing migrated, NO LIVE STAGING SERVICE"
  fail "no verified recovery point; nothing migrated, and $(basename "$prev") did not come back healthy: NO LIVE STAGING SERVICE"
fi
# From here until the deploy commits, a pending marker names this recovery point; a kill at any point is finished by step 0.
write_pending "$rp" "$mh" "$prev" "$new" || { rm -rf "$rp"; cleanup; restart_prev; fail "could not record the pending recovery point; nothing migrated"; }
log "recovery point for $(basename "${prev:-none}") verified before migrating"
restore_db() { python3 "$RECOVERY" restore --db "$staging_db" --dir "$rp" --expect-manifest "$mh"; }
# The migration runs as its own process group (setsid: its pid is the group id) without the deploy lock (fd 9). When it
# exits, anything it left running in that group gets TERM, then KILL, so no migration process outlives this step or
# writes after a restore. A process that leaves the group is out of reach here; #907's contain.py (the build's subreaper)
# is meant to wrap this step the same way once both land. errexit is off inside an `||` list, so a failed env load exits.
mstatus=0
( set -a; . "$ENV_FILE" || exit 1; set +a
  exec 9>&-
  exec setsid bash -c 'if [ "$(id -un)" = "$0" ]; then exec "$@"; else exec runuser -u "$0" -- "$@"; fi' "$RUN_AS" \
    bash -c "cd '$rel/web' && $MIGRATE" ) &
migrate_pid=$!
wait "$migrate_pid" || mstatus=$?
reap_group() { # TERM, a short grace, then KILL whatever is left in the group
  kill -0 -- "-$1" 2>/dev/null || return 0
  kill -TERM -- "-$1" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- "-$1" 2>/dev/null || return 0; sleep 0.5; done
  kill -KILL -- "-$1" 2>/dev/null || true
}
reap_group "$migrate_pid"; migrate_pid=
if [ $mstatus != 0 ]; then
  rm -rf "$rel"
  restore_db || fail "migration of $new failed (exit $mstatus) and the database restore failed: NO LIVE STAGING SERVICE (recovery point kept at $rp)"
  clear_pending
  restart_prev && fail "migration or seed of $new failed (exit $mstatus); database restored, $(basename "$prev") is live again"
  [ -n "$prev" ] || fail "migration or seed of $new failed (exit $mstatus) on a first deployment; database restored, NO LIVE STAGING SERVICE"
  fail "migration of $new failed; database restored, but $(basename "$prev") did not come up healthy: NO LIVE STAGING SERVICE"
fi

# Cutover. From here until the new release is healthy, any failure (the switch, the restart command, readiness)
# goes to cutover_fail, which puts the previous complete release back and checks it is really serving again.
cutover_fail() {
  trap - ERR
  log "cutover of $new failed ($1); restoring the previous release"
  rm -rf "$rel"
  # the pre-migration database goes back BEFORE the old code starts: old code never runs against a migrated schema
  $STOP 9>&- || fail "could not stop the failed release to restore the database: NO VERIFIED STAGING STATE (recovery point kept at $rp)"
  restore_db || fail "database restore failed: NO LIVE STAGING SERVICE (old code not started against a migrated database; recovery point kept at $rp)"
  clear_pending
  if [ -n "$prev" ]; then
    local p; p=$(basename "$prev")
    ln -sfn "$prev" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$p" > "$ROOT/release.env"
    if $RESTART 9>&- && healthy "$p"; then fail "rolled back: $p is live again"; fi
    fail "rollback to $p did not come up healthy: NO LIVE STAGING SERVICE (current points at $p)"
  fi
  # a first deployment has nothing to go back to: leave no pointer at the failed release
  rm -f "$ROOT/current" "$ROOT/release.env"
  fail "first deployment failed: NO LIVE STAGING SERVICE (database restored)"
}
trap 'cutover_fail "a cutover step failed"' ERR
ln -sfn "$rel" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$new" > "$ROOT/release.env"
$RESTART 9>&- || cutover_fail "the restart command failed" # the service must not inherit the deploy lock
healthy "$new" || cutover_fail "/api/health never answered ok with commit $new"
trap - ERR
clear_pending   # the commit point: from here a crash is NOT rolled back (a retry redeploys this commit over its migrated database)
touch "$rel/.complete"; echo "$new" > "$ROOT/current-sha"
log "live: $new"
# Release identity (ops/release-manifest.mjs): the exact commit, build id and readiness the live service reports, in the
# journal and in the release's release.json. A report only; the gate above is /api/health with the commit.
if [ -f "$rel/ops/release-manifest.mjs" ]; then
  if node "$rel/ops/release-manifest.mjs" write "$rel/web" "$rel/release.json" >/dev/null 2>&1; then
    log "release identity: $(node "$rel/ops/release-manifest.mjs" check "$rel/release.json" "http://127.0.0.1:$PORT" 2>&1 | tr '\n' ' ')"
  else log "release identity: not recorded (no build output to describe)"; fi
fi
# recovery points: the three newest are kept (the live release's is the newest)
prune_recovery
# keep the live release and the two complete ones before it
ls -1dt "$ROOT"/releases/*/ | while read -r d; do [ -e "$d/.complete" ] && echo "$d"; done | tail -n +4 | xargs -r rm -rf || true
exit 0
