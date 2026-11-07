#!/usr/bin/env bash
# #988 operator package for the staging sample-data tool. REVIEWED, NEVER AUTO-RUN, NOT PART OF THE RELEASE. It runs from a root-owned copy of THIS directory (verified against SHA256SUMS) and never
# writes into /srv/dazl-staging/current or its release: the deployed app is an immutable compiled package, so the scripts here bring their own copy of lib/staging.ts and use the release's
# node_modules (read-only) for better-sqlite3.
#
#   fixture-988.sh preflight   READ-ONLY, runs while staging stays up. Asserts the layout below, proves the package can run against the live database (the tool's dry-run plan), and reports the
#                              bounded stop/restart it WOULD perform. No lock, no stop, no database or release change; only a temporary directory of symlinks under /run, removed on exit.
#   fixture-988.sh plan        preflight, then the bounded window: lock, RE-ASSERT everything under the lock, stop (confirmed), prepare (snapshot + backup + restore proof), the tool's dry-run plan.
#   fixture-988.sh apply       the same window plus exactly one apply (1 run + 4 leads or nothing) and the independent all-row/all-schema after-proof. Needs APPLY_TENANT_ID=<id printed by plan>.
#
# GUARDED RESTART (read this before running plan/apply). The service is started again ONLY when that restores a known-good state: every check passed, OR the stop was confirmed and the database was
# never handed to the tool. If the stop is not confirmed, or any data check after the database was handed over fails or did not run, the service is LEFT STOPPED ON PURPOSE and the script says so;
# nothing is restarted, retried or killed, and the operator decides. After a restart the script PROVES it (local health, readiness, public HTTPS health with the same commit, the staging banner, a new
# running instance and process, staging environment, same release and database) and reports honestly if any proof fails; it never retries.
#
# Required inputs (no defaults): FIXTURE_EXPECT_BUILD (full 40-hex commit), FIXTURE_EXPECT_INSTANCE (12-hex id from /api/health), and PROD_DB_PATH or PROD_ENV_FILE.
set -uo pipefail
umask 077
# ---- pure decisions (unit-tested by sourcing this file with FIXTURE_988_SOURCE_ONLY=1; no host access here) --------------------------------------------------
# stop_confirmed ACTIVE SUB MAIN_PID CONTROL_PID JOB CGROUP_STATE CGROUP_PROCS: stopped ONLY if systemd says inactive/dead, no main pid, no control pid, no pending job, the control group was READ
# successfully (CGROUP_STATE=ok) and holds no process. "deactivating", "failed", an unreadable or failed cgroup check, a pending job, a leftover process: all NOT stopped.
stop_confirmed() { [ "$1" = inactive ] && [ "$2" = dead ] && [ "$3" = 0 ] && [ "$4" = 0 ] && { [ -z "$5" ] || [ "$5" = 0 ]; } && [ "$6" = ok ] && [ -z "$7" ]; }
# should_start STOP_CONFIRMED DB_TOUCHED VERIFIED: restart only when it restores a known-good state: (a) every check passed (VERIFIED=1), or (b) the stop was confirmed and the database was never
# handed to the tool (DB_TOUCHED=0). Anything else leaves the service where it is.
should_start() { [ "$1" = 1 ] && { [ "$3" = 1 ] || [ "$2" = 0 ]; }; }
# restart_proven: every proof must hold. Inputs are variables set by the caller (R_*): the service state, local health + readiness, public HTTPS health + banner, a NEW instance and process, the staging
# environment of the new process, the same release and the same database file.
restart_proven() {
  [ "${R_ACTIVE:-}" = active ] && [ "${R_SUB:-}" = running ] && [ "${R_MAINPID:-0}" -gt 0 ] 2>/dev/null && [ "${R_CONTROLPID:-1}" = 0 ] && [ -z "${R_JOB-x}" ] || return 1
  [ "${R_LOCAL_OK:-}" = 1 ] && [ "${R_LOCAL_COMMIT:-}" = "${R_BUILD:-?}" ] && [ "${R_READY_OK:-}" = 1 ] && [ "${R_READY_COMMIT:-}" = "${R_BUILD:-?}" ] || return 1
  [ "${R_PUBLIC_OK:-}" = 1 ] && [ "${R_PUBLIC_COMMIT:-}" = "${R_BUILD:-?}" ] && [ "${R_PUBLIC_INSTANCE:-}" = "${R_INSTANCE:-?}" ] && [ "${R_BANNER:-}" = 1 ] || return 1
  [ -n "${R_INSTANCE:-}" ] && [ "${R_INSTANCE:-}" != "${R_OLD_INSTANCE:-}" ] && [ "${R_MAINPID:-}" != "${R_OLD_MAINPID:-}" ] || return 1
  [ "${R_ENV_STAGING:-}" = 1 ] && [ "${R_GMAIL_OFF:-}" = 1 ] && [ "${R_SAME_RELEASE:-}" = 1 ] && [ "${R_SAME_DB:-}" = 1 ]
}
jfield() { printf %s "$2" | grep -o "\"$1\":\"\{0,1\}[^\",}]*" | head -n 1 | sed 's/^[^:]*://; s/"//g'; }   # the FIRST (top-level) field of that name in an /api/health-style body, never a nested check's
[ "${FIXTURE_988_SOURCE_ONLY:-}" = 1 ] && return 0 2>/dev/null
MODE=${1:-}; case "$MODE" in preflight|plan|apply) ;; *) echo "usage: $0 preflight|plan|apply" >&2; exit 2;; esac
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=/srv/dazl-staging                       # the service user's home
LOCK=/srv/dazl-staging/.deploy.lock          # the installed writer lock the deploy takes
CURRENT=/srv/dazl-staging/current            # symlink to the immutable compiled release
RELEASE_ENV=/srv/dazl-staging/release.env    # the installed release environment the service reads
ENV_FILE=/etc/dazl-staging/env
SERVICE=dazl-staging.service
RUN_AS=dazl-staging
STAGING_DB=/var/lib/dazl-staging/app.db
LOCAL=http://127.0.0.1:3200
PUBLIC=https://staging.dazl.ai
BANNER='Staging - test data'                 # lib/staging.ts STAGING_BANNER: shown on every staging page
OUT_ROOT=/var/lib/dazl-staging-recovery/fixture-988
# The build and instance are INPUTS, never defaults baked into the package. At the last check: FIXTURE_EXPECT_BUILD=c17bcb2af431e642c6be6452a5cab2f1ddc6810e FIXTURE_EXPECT_INSTANCE=6517513f7b26
EXPECT_BUILD=${FIXTURE_EXPECT_BUILD:-}; EXPECT_INSTANCE=${FIXTURE_EXPECT_INSTANCE:-}
STOP_WAIT=60 HEALTH_TRIES=60 HEALTH_SLEEP=2     # the only bounds; no retry loop beyond the health wait, no kill
fail() { echo "fixture-988: REFUSED: $*" >&2; exit 3; }
note() { echo "fixture-988: $*"; }
val() { sed -n "s/^\(export \)\{0,1\}$1=//p" "$2" 2>/dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']$//"; }
sv() { systemctl show "$SERVICE" -p "$1" --value 2>/dev/null; }

printf %s "$EXPECT_BUILD" | grep -Eq '^[0-9a-f]{40}$' || { echo "fixture-988: REFUSED: FIXTURE_EXPECT_BUILD must be the full 40-character commit of the release being qualified" >&2; exit 3; }
printf %s "$EXPECT_INSTANCE" | grep -Eq '^[0-9a-f]{12}$' || { echo "fixture-988: REFUSED: FIXTURE_EXPECT_INSTANCE must be the 12-character instance id shown by /api/health" >&2; exit 3; }
# ---- 0. this package: root-owned, not writable by others, bytes match SHA256SUMS ------------------------------------------------------------------
[ "$(id -u)" = 0 ] || fail "run as root"
[ "$(stat -c '%u' -- "$HERE")" = 0 ] && [ -z "$(find "$HERE" -perm /022 -print -quit)" ] || fail "$HERE must be root-owned and not group/world writable"
(cd "$HERE" && sha256sum --check --quiet SHA256SUMS) || fail "package bytes do not match SHA256SUMS"
case "$HERE" in "$ROOT"/*|/srv/dazl-staging-releases/*) fail "the package must live outside the service home and the releases";; esac
[ -n "${PROD_DB_PATH:-}" ] || [ -n "${PROD_ENV_FILE:-}" ] || fail "PROD_DB_PATH or PROD_ENV_FILE is required (to prove production is another file)"
NODE=$(command -v node) || fail "no node"; "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' || fail "node $("$NODE" -v) cannot strip types (need >= 22.6)"

# ---- 1. assert_state: EVERYTHING the operation depends on, read from the host and asserted. Run before the lock AND again under it. --------------------
# Sets: REL INST MAINPID S_ID P_ID LOCK_ID RELENV_ID. Never changes anything.
assert_state() {
  local where=$1 f g h pid s
  systemctl cat "$SERVICE" >/dev/null 2>&1 || fail "[$where] $SERVICE does not exist; I will not pick another service"
  [ "$(sv User)" = "$RUN_AS" ] || fail "[$where] service User is $(sv User), expected $RUN_AS"
  [ "$(sv WorkingDirectory)" = "$CURRENT/web" ] || fail "[$where] service WorkingDirectory is $(sv WorkingDirectory), expected $CURRENT/web"
  s=$(sv EnvironmentFiles); printf %s "$s" | grep -q "$ENV_FILE" || fail "[$where] service does not read $ENV_FILE"
  printf %s "$s" | grep -q "$RELEASE_ENV" || fail "[$where] service does not read $RELEASE_ENV (the installed release environment); EnvironmentFiles=$s"
  sv ExecStart | grep -q 'next start -p 3200' || fail "[$where] service ExecStart is not next start -p 3200"
  [ "$(sv ActiveState)" = active ] && [ "$(sv SubState)" = running ] || fail "[$where] service is not active/running (ActiveState=$(sv ActiveState) SubState=$(sv SubState))"
  [ -z "$(sv Job)" ] || [ "$(sv Job)" = 0 ] || fail "[$where] a systemd job is pending on $SERVICE"
  [ -r "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || fail "[$where] cannot read $ENV_FILE"
  [ -f "$RELEASE_ENV" ] && [ ! -L "$RELEASE_ENV" ] && [ -r "$RELEASE_ENV" ] || fail "[$where] $RELEASE_ENV is not a readable plain file"
  [ -z "$(find "$RELEASE_ENV" -perm /002 -print -quit)" ] || fail "[$where] $RELEASE_ENV is world-writable"
  RELENV_ID=$(stat -c '%d:%i:%u:%a' -- "$RELEASE_ENV")
  [ "$(val DAZL_ENV "$ENV_FILE")" = staging ] || fail "[$where] $ENV_FILE: DAZL_ENV is not staging"
  [ "$(val DB_PATH "$ENV_FILE")" = "$STAGING_DB" ] || fail "[$where] $ENV_FILE: DB_PATH is not $STAGING_DB"
  g=$(val DAZL_COMMIT_SHA "$RELEASE_ENV"); [ -z "$g" ] || [ "$g" = "$EXPECT_BUILD" ] || fail "[$where] $RELEASE_ENV: DAZL_COMMIT_SHA=$g, expected $EXPECT_BUILD"
  for f in "$ENV_FILE" "$RELEASE_ENV"; do g=$(val DAZL_STAGING_REAL_GMAIL "$f"); [ -z "$g" ] || [ "$g" = 0 ] || fail "[$where] $f: DAZL_STAGING_REAL_GMAIL=$g (must be unset or 0)"; done
  pid=$(sv MainPID); [ "$pid" -gt 0 ] 2>/dev/null || fail "[$where] no main pid"; MAINPID=$pid       # the RUNNING service's own environment, not just the files
  [ -r "/proc/$pid/environ" ] || fail "[$where] cannot read /proc/$pid/environ"
  tr '\0' '\n' < "/proc/$pid/environ" | grep -qx 'DAZL_STAGING_REAL_GMAIL=1' && fail "[$where] the running service has DAZL_STAGING_REAL_GMAIL=1"
  tr '\0' '\n' < "/proc/$pid/environ" | grep -qx 'DAZL_ENV=staging' || fail "[$where] the running service is not DAZL_ENV=staging"
  # the immutable release and what is serving
  [ -L "$CURRENT" ] || fail "[$where] $CURRENT is not a symlink"
  REL=$(readlink -f -- "$CURRENT"); [ "$(basename "$REL")" = "$EXPECT_BUILD" ] || fail "[$where] current points to $REL, expected a release named $EXPECT_BUILD"
  [ "$(stat -c '%u' -- "$REL")" = 0 ] && [ -z "$(find "$REL" -maxdepth 1 -perm /022 -print -quit)" ] || fail "[$where] $REL is not root-owned and closed to writers"
  [ -d "$REL/web/node_modules/better-sqlite3" ] || fail "[$where] no better-sqlite3 in the release"
  h=$(curl -fsS --max-time 5 "$LOCAL/api/health" 2>/dev/null) || fail "[$where] health does not answer"
  [ "$(jfield ok "$h")" = true ] && [ "$(jfield commit "$h")" = "$EXPECT_BUILD" ] || fail "[$where] health is not ok on $EXPECT_BUILD: $h"
  INST=$(jfield instance "$h"); [ "$INST" = "$EXPECT_INSTANCE" ] || fail "[$where] health reports instance $INST, FIXTURE_EXPECT_INSTANCE=$EXPECT_INSTANCE (the service restarted or redeployed since it was read)"
  # the database, production, the lock
  [ -f "$STAGING_DB" ] && [ ! -L "$STAGING_DB" ] && [ "$(readlink -f -- "$STAGING_DB")" = "$STAGING_DB" ] || fail "[$where] $STAGING_DB is not a plain file at that path"
  S_ID=$(stat -c '%d:%i' -- "$STAGING_DB"); [ "$(stat -c '%h' -- "$STAGING_DB")" = 1 ] || fail "[$where] $STAGING_DB has more than one hard link"
  PROD=${PROD_DB_PATH:-}; [ -n "$PROD" ] || PROD=$(val DB_PATH "${PROD_ENV_FILE:-/nonexistent}")
  [ -n "$PROD" ] || fail "[$where] production's database path is unknown"
  if [ -e "$PROD" ]; then P_ID=$(stat -c '%d:%i' -- "$PROD"); [ "$S_ID" != "$P_ID" ] || fail "[$where] the staging file IS the production file"; else P_ID=; fi
  [ -f "$LOCK" ] && [ ! -L "$LOCK" ] || fail "[$where] $LOCK is not a plain file (the installed writer lock); I will not create a different one"
  LOCK_ID=$(stat -c '%d:%i' -- "$LOCK")
}
assert_state preflight
PRE="$REL|$INST|$MAINPID|$S_ID|$P_ID|$LOCK_ID|$RELENV_ID"
DB_BYTES=$(stat -c '%s' -- "$STAGING_DB"); FREE=$(df --output=avail -B1 -- "$(dirname "$OUT_ROOT")" 2>/dev/null | tail -1 | tr -d ' ')
[ "${FREE:-0}" -gt $((DB_BYTES * 3 + 1073741824)) ] || fail "not enough free space for a backup (need about 3x the database + 1 GiB; have ${FREE:-unknown})"
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

note "release=$REL build=$EXPECT_BUILD instance=$INST service=$SERVICE($RUN_AS) env=$ENV_FILE+$RELEASE_ENV gmail=off staging_identity=$S_ID production_identity=${P_ID:-none} lock=$LOCK($LOCK_ID) node=$("$NODE" -v)"
note "package=$HERE_PKG (sha256sum --check passed)"
note "READ-ONLY proof the package runs, before anything is stopped: the tool's dry-run plan against the live database"
if ! PLAN=$(TOOL staging-fixture-988.mts 2>&1); then cleanup_rundir; echo "$PLAN" >&2; fail "the tool cannot run against the live database; nothing was stopped or changed"; fi
echo "$PLAN" | tail -22
if [ "$MODE" = preflight ]; then
  note "WOULD DO at plan/apply: take $LOCK (flock -n, non-blocking), re-assert every fact above under the lock, systemctl stop $SERVICE (wait up to ${STOP_WAIT}s, no kill) and CONFIRM it from systemd (inactive/dead, no main or control pid, no pending job, full cgroup read and empty), verify no process has the database open, run the checks. Start $SERVICE once ONLY if every check passed or the database was never handed to the tool, then prove: local health, readiness, public HTTPS health + staging banner, a new instance and process."
  note "preflight passed. Nothing was written, stopped or locked."; cleanup_rundir; exit 0
fi
[ "$MODE" = plan ] || [ -n "${APPLY_TENANT_ID:-}" ] || { cleanup_rundir; fail "APPLY_TENANT_ID is required to apply"; }

# ---- 2. the bounded window --------------------------------------------------------------------------------------------------------------------------
exec 9>>"$LOCK"; flock -n 9 || { cleanup_rundir; fail "the deploy (or another run) holds $LOCK"; }
assert_state locked          # the facts can have moved between the preflight and the lock (a deploy took the lock first, a restart, a new release): re-read and re-assert ALL of them
[ "$PRE" = "$REL|$INST|$MAINPID|$S_ID|$P_ID|$LOCK_ID|$RELENV_ID" ] || { cleanup_rundir; fail "release, instance, main pid, database, production, lock or release.env changed between the preflight and the lock; nothing was stopped"; }
OLD_INSTANCE=$INST OLD_MAINPID=$MAINPID
STOPPED=0 STOP_OK=0 DB_TOUCHED=0 VERIFIED=0 RESULT=1
# The WHOLE control group, read: every cgroup.procs under the unit's cgroup (recursive). An unreadable or missing-without-cgroup2 answer is 'unreadable', never 'empty'.
cgroup_read() {   # prints "ok" then the pids, or "unreadable"
  local cg dir f out="" files
  cg=$(sv ControlGroup); [ -n "$cg" ] || cg=/system.slice/$SERVICE      # an inactive unit reports no ControlGroup; its slice path is deterministic
  dir=/sys/fs/cgroup$cg
  if [ -d "$dir" ]; then
    [ -r "$dir/cgroup.procs" ] || { echo unreadable; return; }
    files=$(find "$dir" -name cgroup.procs 2>/dev/null) || { echo unreadable; return; }
    [ -n "$files" ] || { echo unreadable; return; }
    while IFS= read -r f; do out="$out$(cat -- "$f" 2>/dev/null || echo __unreadable__)"; done <<< "$files"
    case "$out" in *__unreadable__*) echo unreadable; return;; esac
    echo ok; printf '%s' "$out"
  elif [ -e /sys/fs/cgroup/cgroup.controllers ]; then echo ok      # cgroup v2 is mounted and the unit's group is gone: nothing runs in it
  else echo unreadable; fi
}
list_jobs_unit() { local o; o=$(systemctl list-jobs --no-legend 2>&1) || { echo error; return; }; printf '%s\n' "$o" | grep -c "$SERVICE" || true; }   # a failed listing is 'error', never 'none'
prove_restart() {   # fills R_* from the host, then asks restart_proven. Local and public checks poll for up to HEALTH_TRIES * HEALTH_SLEEP seconds; nothing is retried or killed.
  R_BUILD=$EXPECT_BUILD R_OLD_INSTANCE=$OLD_INSTANCE R_OLD_MAINPID=$OLD_MAINPID
  local i h r p pid body
  for i in $(seq 1 "$HEALTH_TRIES"); do
    R_ACTIVE=$(sv ActiveState) R_SUB=$(sv SubState) R_MAINPID=$(sv MainPID) R_CONTROLPID=$(sv ControlPID) R_JOB=$(sv Job); [ "$R_JOB" = 0 ] && R_JOB=
    h=$(curl -fsS --max-time 5 "$LOCAL/api/health" 2>/dev/null || true); R_LOCAL_OK=0; [ "$(jfield ok "$h")" = true ] && R_LOCAL_OK=1; R_LOCAL_COMMIT=$(jfield commit "$h"); R_INSTANCE=$(jfield instance "$h")
    r=$(curl -fsS --max-time 5 "$LOCAL/api/ready" 2>/dev/null || true); R_READY_OK=0; [ "$(jfield ok "$r")" = true ] && R_READY_OK=1; R_READY_COMMIT=$(jfield commit "$r")
    p=$(curl -fsS --max-time 8 "$PUBLIC/api/health" 2>/dev/null || true); R_PUBLIC_OK=0; [ "$(jfield ok "$p")" = true ] && R_PUBLIC_OK=1; R_PUBLIC_COMMIT=$(jfield commit "$p"); R_PUBLIC_INSTANCE=$(jfield instance "$p")
    body=$(curl -fsS --max-time 8 "$PUBLIC/" 2>/dev/null || true); R_BANNER=0; printf %s "$body" | grep -qF "$BANNER" && R_BANNER=1
    pid=$R_MAINPID; R_ENV_STAGING=0 R_GMAIL_OFF=0
    if [ "$pid" -gt 0 ] 2>/dev/null && [ -r "/proc/$pid/environ" ]; then
      tr '\0' '\n' < "/proc/$pid/environ" | grep -qx 'DAZL_ENV=staging' && R_ENV_STAGING=1
      tr '\0' '\n' < "/proc/$pid/environ" | grep -qx 'DAZL_STAGING_REAL_GMAIL=1' || R_GMAIL_OFF=1
    fi
    R_SAME_RELEASE=0; [ "$(readlink -f -- "$CURRENT")" = "$REL" ] && R_SAME_RELEASE=1
    R_SAME_DB=0; [ "$(stat -c '%d:%i:%h' -- "$STAGING_DB" 2>/dev/null)" = "$S_ID:1" ] && R_SAME_DB=1
    restart_proven && return 0
    sleep "$HEALTH_SLEEP"
  done
  return 1
}
finish() {   # runs once on every exit after the lock. One start at most, and only when should_start says it restores a known-good state. No retry loop, no kill.
  trap - EXIT
  if should_start "$STOP_OK" "$DB_TOUCHED" "$VERIFIED"; then
    note "starting $SERVICE (single start, no retry)"; systemctl start "$SERVICE" || note "systemctl start returned non-zero"
    if prove_restart; then note "RESTART PROVEN: active/running as a NEW process $R_MAINPID, NEW instance $R_INSTANCE (was $OLD_INSTANCE), health + readiness ok on $EXPECT_BUILD locally and at $PUBLIC, staging banner shown, staging environment, same release $REL and database"
    else echo "fixture-988: !!! RESTART NOT PROVEN (active=${R_ACTIVE:-?}/${R_SUB:-?} mainpid=${R_MAINPID:-?} local_ok=${R_LOCAL_OK:-?} ready_ok=${R_READY_OK:-?} public_ok=${R_PUBLIC_OK:-?} public_commit=${R_PUBLIC_COMMIT:-?} banner=${R_BANNER:-?} instance=${R_INSTANCE:-?} old=$OLD_INSTANCE env_staging=${R_ENV_STAGING:-?} release_same=${R_SAME_RELEASE:-?} db_same=${R_SAME_DB:-?}). Nothing was retried or killed. Operator action needed: systemctl status $SERVICE; journalctl -u $SERVICE -n 80. Backup (if made): $OUT_ROOT" >&2; RESULT=4; fi
  elif [ "$STOPPED" = 1 ]; then
    echo "fixture-988: !!! THE SERVICE IS LEFT STOPPED ON PURPOSE (stop_confirmed=$STOP_OK db_touched=$DB_TOUCHED verified=$VERIFIED). The stop was not confirmed or a data check did not pass, so restarting could run the app on unverified data or start a service that may still be running. Nothing was restarted, retried or killed. Backup (if made): $OUT_ROOT. Operator decision needed." >&2
  fi
  cleanup_rundir; exit "$RESULT"
}
trap finish EXIT
note "stopping $SERVICE (bounded ${STOP_WAIT}s; a service that does not stop is reported, never killed)"
STOPPED=1   # a stop was attempted: finish() reports it either way
timeout "$STOP_WAIT" systemctl stop "$SERVICE" || true
# CONFIRM, do not infer: systemd's own state, no main or control pid, no pending job, and the WHOLE control group read and empty. Only then does anything else run.
CG=$(cgroup_read); CGS=$(printf '%s\n' "$CG" | sed -n 1p); CGP=$(printf '%s\n' "$CG" | sed -n '2,$p' | tr -d '[:space:]'); JOBS=$(sv Job); [ "$(list_jobs_unit)" = 0 ] || JOBS="${JOBS:-listed}"
stop_confirmed "$(sv ActiveState)" "$(sv SubState)" "$(sv MainPID)" "$(sv ControlPID)" "$JOBS" "$CGS" "$CGP" || { RESULT=5; fail "the service is NOT confirmed stopped (ActiveState=$(sv ActiveState) SubState=$(sv SubState) MainPID=$(sv MainPID) ControlPID=$(sv ControlPID) Job=${JOBS:-none} cgroup=$CGS procs=${CGP:-none}); nothing was done to the database"; }
STOP_OK=1
for f in "$STAGING_DB" "$STAGING_DB-wal" "$STAGING_DB-shm"; do [ -e "$f" ] || continue; if fuser -s -- "$f" 2>/dev/null; then RESULT=6; fail "a process still has $f open"; fi; done
[ "$(stat -c '%d:%i:%h' -- "$STAGING_DB")" = "$S_ID:1" ] || { RESULT=6; fail "the staging file changed identity"; }

DIR="$OUT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
note "prepare: file hash, snapshot, backup, restore proof, file hash again -> $DIR"
DB_TOUCHED=1   # from here the database is in the tool's hands: a failure leaves the service stopped
TOOL staging-fixture-988-checks.mts prepare --dir="$DIR" || { RESULT=7; exit 7; }
note "the tool's dry-run plan on the stopped database"; TOOL staging-fixture-988.mts || { RESULT=7; exit 7; }
if [ "$MODE" = apply ]; then
  note "apply: exactly one run and four leads in one transaction, or nothing"
  TOOL staging-fixture-988.mts --apply --tenant-id="$APPLY_TENANT_ID" || { RESULT=8; exit 8; }
  note "independent all-row, all-schema after-proof against the SAME snapshot (read-only)"
  TOOL staging-fixture-988-checks.mts after --snapshot="$DIR/snapshot.json" || { RESULT=9; exit 9; }
  [ "$(stat -c '%d:%i:%h' -- "$STAGING_DB")" = "$S_ID:1" ] || { RESULT=9; fail "the staging file changed identity during the operation"; }
fi
VERIFIED=1; RESULT=0; note "window complete (every check passed); starting the service and proving the restart. Restore, if ever needed, is a manual copy of $DIR/backup.db with the service stopped."
exit 0
