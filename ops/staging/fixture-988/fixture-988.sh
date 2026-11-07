#!/usr/bin/env bash
# #988 operator package for the staging sample-data tool. REVIEWED, NEVER AUTO-RUN, NOT PART OF THE RELEASE. It runs from a root-owned copy of THIS directory (verified against SHA256SUMS) and never
# writes into /srv/dazl-staging/current or its release: the deployed app is an immutable compiled package, so the scripts here bring their own copy of lib/staging.ts and use the release's
# node_modules (read-only) for better-sqlite3.
#
#   fixture-988.sh preflight   READ-ONLY, runs while staging stays up. Binds every detail below, proves the package can run against the live database (the tool's dry-run plan), and reports the
#                              bounded stop/restart it WOULD perform. Writes nothing, takes no lock, stops nothing.
#   fixture-988.sh plan        preflight, then the bounded window: lock, stop, prepare (snapshot + backup + restore proof), the dry-run plan, restart + health proof.
#   fixture-988.sh apply       the same window with exactly one apply (1 run + 4 leads or nothing) and the independent all-row/all-schema after-proof before restart.
#                              Needs APPLY_TENANT_ID=<the id printed by plan>.
#
# Required: PROD_DB_PATH or PROD_ENV_FILE (production's database, to prove it is another file).
# The facts below are Instinct's review of 1be52e2e: change them only with the review. Each is ASSERTED, never assumed.
set -uo pipefail
umask 077
MODE=${1:-}; case "$MODE" in preflight|plan|apply) ;; *) echo "usage: $0 preflight|plan|apply" >&2; exit 2;; esac
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=/srv/dazl-staging                       # the service user's home
LOCK=/srv/dazl-staging/.deploy.lock          # the installed writer lock the deploy takes
CURRENT=/srv/dazl-staging/current            # symlink to the immutable compiled release
EXPECT_BUILD=3fb1e7dfdcca1bdca65af3113b5aca3fa55551cf
EXPECT_INSTANCE=786b801b2fa7
SERVICE=dazl-staging.service
RUN_AS=dazl-staging
ENV_FILE=/etc/dazl-staging/env
RELEASE_ENV=/var/lib/dazl-staging-deploy/release.env
STAGING_DB=/var/lib/dazl-staging/app.db
HEALTH=http://127.0.0.1:3200/api/health
OUT_ROOT=/var/lib/dazl-staging-recovery/fixture-988
STOP_WAIT=60 HEALTH_TRIES=60 HEALTH_SLEEP=2     # the only bounds; no retry loop beyond the health wait, no kill
fail() { echo "fixture-988: REFUSED: $*" >&2; exit 3; }
note() { echo "fixture-988: $*"; }
val() { sed -n "s/^\(export \)\{0,1\}$1=//p" "$2" 2>/dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']$//"; }

# ---- 0. this package: root-owned, not writable by others, bytes match SHA256SUMS ------------------------------------------------------------------
[ "$(id -u)" = 0 ] || fail "run as root"
[ "$(stat -c '%u' -- "$HERE")" = 0 ] && [ -z "$(find "$HERE" -perm /022 -print -quit)" ] || fail "$HERE must be root-owned and not group/world writable"
(cd "$HERE" && sha256sum --check --quiet SHA256SUMS) || fail "package bytes do not match SHA256SUMS"
case "$HERE" in "$ROOT"/*|/srv/dazl-staging-releases/*) fail "the package must live outside the service home and the releases";; esac

# ---- 1. the real service, its unit and its environment: read, then assert ---------------------------------------------------------------------------
systemctl cat "$SERVICE" >/dev/null 2>&1 || fail "$SERVICE does not exist; I will not pick another service"
sv() { systemctl show "$SERVICE" -p "$1" --value; }
[ "$(sv User)" = "$RUN_AS" ] || fail "service User is $(sv User), expected $RUN_AS"
[ "$(sv WorkingDirectory)" = "$CURRENT/web" ] || fail "service WorkingDirectory is $(sv WorkingDirectory), expected $CURRENT/web"
sv EnvironmentFiles | grep -q "$ENV_FILE" || fail "service does not read $ENV_FILE"
sv ExecStart | grep -q 'next start -p 3200' || fail "service ExecStart is not next start -p 3200"
[ -r "$ENV_FILE" ] || fail "cannot read $ENV_FILE"
[ "$(val DAZL_ENV "$ENV_FILE")" = staging ] || fail "$ENV_FILE: DAZL_ENV is not staging"
[ "$(val DB_PATH "$ENV_FILE")" = "$STAGING_DB" ] || fail "$ENV_FILE: DB_PATH is not $STAGING_DB"
for f in "$ENV_FILE" "$RELEASE_ENV"; do g=$(val DAZL_STAGING_REAL_GMAIL "$f"); [ -z "$g" ] || [ "$g" = 0 ] || fail "$f: DAZL_STAGING_REAL_GMAIL=$g (must be unset or 0)"; done
PID=$(sv MainPID)
if [ "$(sv ActiveState)" = active ] && [ "$PID" -gt 0 ]; then   # the RUNNING service's own environment, not just the file
  tr '\0' '\n' < "/proc/$PID/environ" | grep -qx 'DAZL_STAGING_REAL_GMAIL=1' && fail "the running service has DAZL_STAGING_REAL_GMAIL=1"
  tr '\0' '\n' < "/proc/$PID/environ" | grep -qx 'DAZL_ENV=staging' || fail "the running service is not DAZL_ENV=staging"
fi

# ---- 2. the immutable release and what is serving ---------------------------------------------------------------------------------------------------
[ -L "$CURRENT" ] || fail "$CURRENT is not a symlink"
REL=$(readlink -f -- "$CURRENT"); [ "$(basename "$REL")" = "$EXPECT_BUILD" ] || fail "current points to $REL, expected a release named $EXPECT_BUILD"
[ "$(stat -c '%u' -- "$REL")" = 0 ] && [ -z "$(find "$REL" -maxdepth 1 -perm /022 -print -quit)" ] || fail "$REL is not root-owned and closed to writers; I will not run anything that treats it as mutable"
[ -d "$REL/web/node_modules/better-sqlite3" ] || fail "no better-sqlite3 in the release"
NODE=$(command -v node) || fail "no node"; "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' || fail "node $("$NODE" -v) cannot strip types (need >= 22.6)"
H=$(curl -fsS --max-time 5 "$HEALTH" 2>/dev/null) || fail "health does not answer; nothing was changed"
echo "$H" | grep -q "\"commit\":\"$EXPECT_BUILD\"" && echo "$H" | grep -q '"ok":true' || fail "health is not ok on $EXPECT_BUILD: $H"
echo "$H" | grep -q "\"instance\":\"$EXPECT_INSTANCE\"" || note "NOTE: instance is not $EXPECT_INSTANCE (the service restarted since the review); build is still $EXPECT_BUILD"

# ---- 3. the database, production, the lock, the output directory ----------------------------------------------------------------------------------
[ -f "$STAGING_DB" ] && [ ! -L "$STAGING_DB" ] && [ "$(readlink -f -- "$STAGING_DB")" = "$STAGING_DB" ] || fail "$STAGING_DB is not a plain file at that path"
S_ID=$(stat -c '%d:%i' -- "$STAGING_DB"); [ "$(stat -c '%h' -- "$STAGING_DB")" = 1 ] || fail "$STAGING_DB has more than one hard link"
PROD=${PROD_DB_PATH:-}; [ -n "$PROD" ] || { [ -n "${PROD_ENV_FILE:-}" ] && PROD=$(val DB_PATH "$PROD_ENV_FILE"); }
[ -n "$PROD" ] || fail "PROD_DB_PATH or PROD_ENV_FILE is required"
if [ -e "$PROD" ]; then P_ID=$(stat -c '%d:%i' -- "$PROD"); [ "$S_ID" != "$P_ID" ] || fail "the staging file IS the production file"; else P_ID=; fi
[ -f "$LOCK" ] && [ ! -L "$LOCK" ] || fail "$LOCK is not a plain file (the installed writer lock); I will not create a different one"
LOCK_ID=$(stat -c '%d:%i' -- "$LOCK")
DB_BYTES=$(stat -c '%s' -- "$STAGING_DB"); FREE=$(df --output=avail -B1 -- "$(dirname "$OUT_ROOT")" | tail -1 | tr -d ' ')
[ "$FREE" -gt $((DB_BYTES * 3 + 1073741824)) ] || fail "not enough free space for a backup (need about 3x the database + 1 GiB; have $FREE)"
# output directory: private (0700) AND owned by the account that runs the tool, so that account can create the backup in it
if [ "$MODE" != preflight ]; then
  [ -d "$(dirname "$OUT_ROOT")" ] || fail "$(dirname "$OUT_ROOT") does not exist (the recovery root the deploy already uses)"
  install -d -m 0700 -o "$RUN_AS" -g "$RUN_AS" "$OUT_ROOT" || fail "cannot create $OUT_ROOT"
fi
[ "$MODE" != preflight ] || { [ -d "$OUT_ROOT" ] && [ "$(stat -c '%U:%a' -- "$OUT_ROOT")" = "$RUN_AS:700" ] || note "NOTE: $OUT_ROOT will be created $RUN_AS:700 at plan/apply time"; }

TOOL() { runuser -u "$RUN_AS" -- env DAZL_ENV=staging DB_PATH="$STAGING_DB" DAZL_STAGING_REAL_GMAIL=0 DAZL_FIXTURE_DB_IDENTITY="$S_ID" DAZL_FIXTURE_PROD_DB_IDENTITY="$P_ID" \
  "$NODE" --preserve-symlinks --preserve-symlinks-main --experimental-strip-types --no-warnings "$HERE/scripts/$1" "${@:2}"; }
# The tool resolves better-sqlite3 from a node_modules next to it; that is a symlink INSIDE A TEMPORARY OPERATOR RUN DIRECTORY (below, under /run), never in the release.
RUNDIR=$(mktemp -d /run/fixture-988.XXXXXX) || fail "cannot create a run directory"; chmod 0755 "$RUNDIR"
cleanup_rundir() { rm -f -- "$RUNDIR/node_modules" "$RUNDIR/scripts" "$RUNDIR/lib" 2>/dev/null; rmdir -- "$RUNDIR" 2>/dev/null || true; }
ln -s "$REL/web/node_modules" "$RUNDIR/node_modules"; ln -s "$HERE/scripts" "$RUNDIR/scripts"; ln -s "$HERE/lib" "$RUNDIR/lib"
HERE_PKG=$HERE; HERE=$RUNDIR      # run through the symlinked tree so Node's resolution finds the release's node_modules without writing anything into it

note "release=$REL build=$EXPECT_BUILD service=$SERVICE($RUN_AS) env=$ENV_FILE gmail=off staging_identity=$S_ID production_identity=${P_ID:-none} lock=$LOCK($LOCK_ID) node=$("$NODE" -v)"
note "package=$HERE_PKG (sha256sum --check passed)"
note "READ-ONLY proof the package runs, before anything is stopped: the tool's dry-run plan against the live database"
if ! PLAN=$(TOOL staging-fixture-988.mts 2>&1); then cleanup_rundir; echo "$PLAN" >&2; fail "the tool cannot run against the live database; nothing was stopped or changed"; fi
echo "$PLAN" | tail -22
if [ "$MODE" = preflight ]; then
  note "WOULD DO at plan/apply: take $LOCK (flock -n, non-blocking), systemctl stop $SERVICE (wait up to ${STOP_WAIT}s, no kill), verify no process has the database open, run the checks, ALWAYS systemctl start $SERVICE once, wait up to $((HEALTH_TRIES*HEALTH_SLEEP))s for health ok on $EXPECT_BUILD."
  note "preflight passed. Nothing was written, stopped or locked."; cleanup_rundir; exit 0
fi
[ "$MODE" = plan ] || [ -n "${APPLY_TENANT_ID:-}" ] || { cleanup_rundir; fail "APPLY_TENANT_ID is required to apply"; }

# ---- 4. the bounded window --------------------------------------------------------------------------------------------------------------------------
exec 9>>"$LOCK"; flock -n 9 || { cleanup_rundir; fail "the deploy (or another run) holds $LOCK"; }
[ "$(stat -c '%d:%i' -- "$LOCK")" = "$LOCK_ID" ] || { cleanup_rundir; fail "the lock file was replaced"; }
STOPPED=0; RESULT=1
finish() {   # runs once on every exit after the stop: one start, one bounded health wait, an honest verdict. No retry loop, no kill.
  trap - EXIT
  if [ "$STOPPED" = 1 ]; then
    note "starting $SERVICE (single start, no retry)"; systemctl start "$SERVICE" || note "systemctl start returned non-zero"
    ok=0; for _ in $(seq 1 "$HEALTH_TRIES"); do
      h=$(curl -fsS --max-time 5 "$HEALTH" 2>/dev/null || true)
      if echo "$h" | grep -q "\"commit\":\"$EXPECT_BUILD\"" && echo "$h" | grep -q '"ok":true'; then ok=1; break; fi; sleep "$HEALTH_SLEEP"
    done
    [ "$(readlink -f -- "$CURRENT")" = "$REL" ] || ok=0
    if [ "$ok" = 1 ]; then note "HEALTH OK on $EXPECT_BUILD, same release $REL: $(echo "$h" | cut -c1-200)"
    else echo "fixture-988: !!! SERVICE IS NOT HEALTHY ON THE SAME CODE after the window. Nothing was retried or killed. Operator action needed: systemctl status $SERVICE; journalctl -u $SERVICE -n 80. Backup (if made): $OUT_ROOT" >&2; RESULT=4; fi
  fi
  cleanup_rundir; exit "$RESULT"
}
trap finish EXIT
note "stopping $SERVICE (bounded ${STOP_WAIT}s; a service that does not stop is reported, never killed)"
STOPPED=1   # from here on, exactly one start is attempted on exit, whatever happens
timeout "$STOP_WAIT" systemctl stop "$SERVICE" || { systemctl is-active --quiet "$SERVICE" && { note "stop did not complete; the service is still active; nothing was done to the database"; RESULT=5; exit 5; }; }
systemctl is-active --quiet "$SERVICE" && { RESULT=5; fail "service is still active after stop"; }
for f in "$STAGING_DB" "$STAGING_DB-wal" "$STAGING_DB-shm"; do [ -e "$f" ] || continue; if fuser -s -- "$f" 2>/dev/null; then RESULT=6; fail "a process still has $f open"; fi; done
[ "$(stat -c '%d:%i:%h' -- "$STAGING_DB")" = "$S_ID:1" ] || { RESULT=6; fail "the staging file changed identity"; }

DIR="$OUT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
note "prepare: file hash, snapshot, backup, restore proof, file hash again -> $DIR"
TOOL staging-fixture-988-checks.mts prepare --dir="$DIR" || { RESULT=7; exit 7; }
note "the tool's dry-run plan on the stopped database"; TOOL staging-fixture-988.mts || { RESULT=7; exit 7; }
if [ "$MODE" = apply ]; then
  note "apply: exactly one run and four leads in one transaction, or nothing"
  TOOL staging-fixture-988.mts --apply --tenant-id="$APPLY_TENANT_ID" || { RESULT=8; exit 8; }
  note "independent all-row, all-schema after-proof against the SAME snapshot (read-only)"
  TOOL staging-fixture-988-checks.mts after --snapshot="$DIR/snapshot.json" || { RESULT=9; exit 9; }
  [ "$(stat -c '%d:%i:%h' -- "$STAGING_DB")" = "$S_ID:1" ] || { RESULT=9; fail "the staging file changed identity during the operation"; }
fi
RESULT=0; note "window complete; restarting. Restore, if ever needed, is a manual copy of $DIR/backup.db with the service stopped."
exit 0
