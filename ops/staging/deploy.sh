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
# Releases live in STAGING_RELEASES (root's, mode 750, beside the service home, never inside it), so the service account
# cannot rename or swap a release path between root's check and its use (#908).
# A release that fails at any step is deleted at once. Complete releases are marked; the live one and the two before
# it are kept, older ones are deleted. node_modules is hard-linked from the live release when package-lock.json is
# unchanged, so a release then costs about the size of its build output.
# Usage: deploy.sh                    deploy origin/main if it changed
#        deploy.sh --check-env FILE   only validate an env file (exit 0 = safe); values are never printed
set -euo pipefail

ROOT=${STAGING_ROOT:-/srv/dazl-staging}
# Releases (#908 rename race): in a directory root owns (mode 750, group the service account's, so it can read and run them)
# BESIDE the service home, never inside it. The service account cannot rename, replace or plant entries there, so every
# release path root creates, sizes, links or deletes is one that account cannot swap between a check and its use.
RELS=${STAGING_RELEASES:-${ROOT}-releases}
ENV_FILE=${STAGING_ENV_FILE:-/etc/dazl-staging/env}
PORT=${STAGING_PORT:-3200}
SERVICE=${STAGING_SERVICE:-dazl-staging.service}
RUN_AS=${STAGING_USER:-dazl-staging}
REPO_URL=${STAGING_REPO_URL:-https://github.com/gagan114662/dazl.git}
# The scan worker (#836, ops/staging/dazl-staging-worker.service): a second process on the same release and database.
# When its unit is installed, it is stopped with the app (before a recovery point, a restore or a migration: nothing
# else may write) and never left running an old release beside a new one; it is started again after the app's restart
# command returns, when enabled (the unit is not pulled in by the app's start: this script and the operator start it). Not installed: nothing below touches it. Tests replace SYSTEMCTL, or STOP and RESTART whole.
WORKER=${STAGING_WORKER_SERVICE:-dazl-staging-worker.service}
SYSTEMCTL=${STAGING_SYSTEMCTL:-systemctl}
worker_installed() { $SYSTEMCTL cat "$WORKER" >/dev/null 2>&1; }
# Stop the worker first and by name, so the command returns only once it has exited: PartOf alone would stop it too,
# but without waiting for it before the recovery point is taken.
stop_services() {
  if worker_installed; then $SYSTEMCTL stop "$WORKER" || return 1; fi
  $SYSTEMCTL stop "$SERVICE"
}
# Restart the app on the release `current` names; the worker is stopped first and started after it (a worker that does
# not start is reported, not a failed deploy: the app still runs every scan itself).
restart_services() {
  if worker_installed; then $SYSTEMCTL stop "$WORKER" || return 1; fi
  $SYSTEMCTL restart "$SERVICE" || return 1
  if worker_installed && $SYSTEMCTL is-enabled --quiet "$WORKER"; then
    $SYSTEMCTL start "$WORKER" || echo "staging-deploy: ALERT scan worker $WORKER did not start; scans run on the app only" >&2
  fi
}
RESTART=${STAGING_RESTART:-restart_services}
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
STOP=${STAGING_STOP:-stop_services}
# The recovery helper, installed beside this script in a root-owned directory (docs/STAGING.md), and the root-only directory
# recovery points live in: outside STAGING_ROOT (the service account's home) so that account cannot rename or replace them.
RECOVERY=${STAGING_RECOVERY:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/recovery_point.py}
RROOT=${STAGING_RECOVERY_ROOT:-/var/lib/dazl-staging-recovery}
# The deploy's own state (#972): the lock, the deployed commit, the release env the service unit reads, alert stamps. Root-only
# (mode 700) and outside STAGING_ROOT, which the service account owns: root never opens, writes or truncates a file by a name
# that account can replace with a symlink. systemd reads release.env as root, so the service needs no access to this directory.
STATE=${STAGING_STATE_ROOT:-/var/lib/dazl-staging-deploy}
HEALTH_TRIES=${STAGING_HEALTH_TRIES:-60}
# Build containment (#907): the build runs under ops/staging/contain.py, a child subreaper, so a descendant that leaves the
# build's session/process group is still ours; on any exit or abort the whole tree gets TERM, BUILD_GRACE seconds, KILL.
CONTAIN=${STAGING_CONTAIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/contain.py}
BUILD_GRACE=${STAGING_BUILD_GRACE:-10}
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
# STAGING_ROOT is the service account's home: never a symlink. Root keeps nothing in it but the `current` symlink.
[ ! -L "$ROOT" ] || fail "STAGING_ROOT $ROOT is a symlink"
# A directory chain root may act in: every existing directory from / down to $1 (resolved physically, so a symlinked
# component is judged by its target) is owned by root (or by the user running the deploy, in tests) and writable by no
# one else, unless it is a root-owned sticky directory like /tmp, where others cannot rename what they do not own.
secure_chain() {
  local d o m; d=$(realpath -m -- "$1")
  while :; do
    if [ -e "$d" ]; then
      o=$(stat -c %u "$d"); m=$(stat -c %a "$d")
      { [ "$o" = 0 ] || [ "$o" = "$(id -u)" ]; } || return 1
      if [ $(( 8#$m & 8#022 )) != 0 ]; then [ "$o" = 0 ] && [ $(( 8#$m & 8#1000 )) != 0 ] || return 1; fi
    fi
    [ "$d" = / ] && return 0
    d=$(dirname "$d")
  done
}
# The releases directory: root's, outside the service home, on a chain only root can change, before anything is stopped.
[ ! -L "$RELS" ] || fail "the releases directory $RELS is a symlink; nothing stopped or changed"
rels_real=$(realpath -m -- "$RELS")
case "$rels_real/" in "$root_real/"*) fail "the releases directory $RELS is inside the service home $ROOT; nothing stopped or changed";; esac
case "$root_real/" in "$rels_real/"*) fail "the releases directory $RELS contains the service home $ROOT; nothing stopped or changed";; esac
case "$rels_real/" in "$prod_dir/"*) fail "the releases directory $RELS is inside production's data directory";; esac
case "$prod_dir/" in "$rels_real/"*) fail "the releases directory $RELS contains production's data directory";; esac
secure_chain "$(dirname "$rels_real")" || fail "the releases directory's parent $(dirname "$RELS") can be changed by another user; nothing stopped or changed"
[ -e "$RELS" ] || install -d -o "$(id -u)" -g "$(id -gn "$RUN_AS")" -m 750 "$RELS"
[ -d "$RELS" ] && [ ! -L "$RELS" ] || fail "the releases directory $RELS is not a plain directory; nothing stopped or changed"
secure_chain "$RELS" || fail "the releases directory $RELS is writable by another user (it must be root's, mode 750); nothing stopped or changed"
# `current` is the one name root still writes in the home: it must be a symlink (or absent), never a directory root would
# write into, and a box upgraded from in-home releases must have moved them first (docs/STAGING.md, upgrading).
if [ -e "$ROOT/current" ] || [ -L "$ROOT/current" ]; then
  [ -L "$ROOT/current" ] || fail "$ROOT/current is not a symlink; nothing stopped or changed"
  case "$(readlink -- "$ROOT/current")" in
    "$ROOT/releases/"*|releases/*) fail "$ROOT/current points into the old in-home releases directory; move the releases to $RELS first (docs/STAGING.md, upgrading); nothing stopped or changed";;
  esac
fi
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
[ ! -L "$STATE" ] || fail "the deploy state directory $STATE is a symlink; nothing stopped or changed"
[ -d "$STATE" ] || install -d -m 700 "$STATE"
python3 "$RECOVERY" check-root --dir "$STATE" || fail "the deploy state directory $STATE is not private to root; nothing stopped or changed"
exec 9>"$STATE/.deploy.lock"; flock -n 9 || { log "another deploy is running"; exit 0; }
# A command run as the service account (reading, linking or running a release's own files).
as() { if [ "$(id -un)" = "$RUN_AS" ]; then "$@"; else runuser -u "$RUN_AS" -- "$@"; fi; }
# A file root creates inside a release (owned by the service account): created exclusively, never through a planted symlink.
safe_touch() { rm -f "$1"; python3 -c 'import os,sys; os.close(os.open(sys.argv[1], os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o644))' "$1"; }
# The live release, from the `current` symlink the service account could repoint: only a real directory directly under
# the releases directory counts (never a symlink, never anything outside), so root never keeps or deletes an arbitrary path.
live_release() {
  [ -L "$ROOT/current" ] || return 0
  local t; t=$(readlink -- "$ROOT/current")
  case "$t" in "$RELS/"*) ;; *) return 0;; esac
  local b=${t#"$RELS/"}
  case "$b" in ''|*/*|.|..) return 0;; esac
  [ -d "$t" ] && [ ! -L "$t" ] && printf '%s' "$t"
}
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
  local smoke="$RELS/$1/ops/health-smoke.mjs"
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if [ -f "$smoke" ]; then as node "$smoke" "http://127.0.0.1:$PORT" "$1" 2>/dev/null && return 0
    else curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q "\"commit\":\"$1\"" && return 0; fi
    sleep 2
  done
  [ -f "$smoke" ] && as node "$smoke" "http://127.0.0.1:$PORT" "$1" >&2 || true # the last reason, in the journal
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
  [ -n "$p_new" ] && [ "$RELS/$p_new" != "$p_prev" ] && rm -rf "$RELS/$p_new"
  if [ -n "$p_prev" ] && [ -d "$p_prev" ]; then
    ln -sfn "$p_prev" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$(basename "$p_prev")" > "$STATE/release.env"
    $RESTART 9>&- && healthy "$(basename "$p_prev")" && fail "recovered the interrupted deploy of $p_new: database restored, $(basename "$p_prev") is live again"
    fail "recovered the interrupted deploy of $p_new: database restored, but $(basename "$p_prev") did not come up healthy: NO LIVE STAGING SERVICE"
  fi
  rm -f "$ROOT/current" "$STATE/release.env"
  fail "recovered the interrupted first deployment of $p_new: database restored, NO LIVE STAGING SERVICE"
fi
free_bytes() { df -B1 --output=avail "$ROOT" | tail -n 1 | tr -d ' '; }
alert() { # reason, free bytes, bytes needed (0 when only the floor matters), message
  local reason=$1 free=$2 need=$3 msg=$4 stamp="$STATE/.alert-$1" now
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
disk_ok() { rm -f "$STATE"/.alert-low_disk*; } # back above the floor: the next low-disk event alerts at once

# Below the floor already: skip this run before fetching or building anything.
avail=$(free_bytes)
if [ "$avail" -lt "$MIN_FREE_BYTES" ]; then
  alert low_disk "$avail" 0 "skipped: $avail bytes free, below the floor of $MIN_FREE_BYTES; nothing fetched, built or deleted"
  exit 0
fi

# leftovers of an interrupted deploy (no completion mark) go first
live_now=$(live_release)
for d in "$RELS"/*; do [ -L "$d" ] && { rm -f "$d"; continue; }; [ -d "$d" ] && [ ! -e "$d/.complete" ] && [ "$live_now" != "$d" ] && rm -rf "$d"; done

[ -d "$ROOT/repo/.git" ] || as git clone -q --no-checkout "$REPO_URL" "$ROOT/repo"
as git -C "$ROOT/repo" fetch -q origin main
new=$(as git -C "$ROOT/repo" rev-parse origin/main)
cur=$(cat "$STATE/current-sha" 2>/dev/null || true)
# Upgrading from a deploy that kept current-sha in STAGING_ROOT: the old file is the service account's and is not read; the
# validated, complete live release names the deployed commit instead.
if [ -z "$cur" ]; then l=$(live_release); [ -n "$l" ] && [ -e "$l/.complete" ] && cur=$(basename "$l"); fi
[ "$new" != "$cur" ] || exit 0

# the live release: only when `current` is a symlink (readlink -f of a missing path returns the path itself)
live=$(live_release)
reuse=0
if [ -n "$live" ] && [ -d "$live/web/node_modules" ] && as git -C "$ROOT/repo" diff --quiet "$cur" "$new" -- web/package-lock.json 2>/dev/null; then reuse=1; fi
if [ -n "$live" ] && [ -d "$live/web" ]; then
  est=$(as du -sb --exclude=node_modules "$live/web" | cut -f1)
  [ $reuse = 1 ] || est=$(( est + $(as du -sb "$live/web/node_modules" | cut -f1) ))
else est=$FIRST_RELEASE_BYTES; fi
avail=$(free_bytes)
if [ $(( avail - est )) -lt $(( MIN_FREE_BYTES + DISK_RESERVE_BYTES )) ]; then
  alert low_disk_for_release "$avail" "$est" "skipped $new: $avail bytes free, a release needs about $est, and the floor is $MIN_FREE_BYTES plus a reserve of $DISK_RESERVE_BYTES; the live release is unchanged"
  exit 0
fi
disk_ok
log "deploying $new (was ${cur:-none}); $avail bytes free, release about $est"

rel="$RELS/$new"
build_pid=
# Stop the build and CONFIRM it is gone: contain.py exits only once every build process has exited, or with 125 when one
# survived SIGKILL (blocked cleanup). The release is deleted only after a confirmed stop, never beneath a live process.
stop_build() {
  [ -n "$build_pid" ] || return 0
  kill -TERM "$build_pid" 2>/dev/null || true
  local st=0; wait "$build_pid" 2>/dev/null || st=$?
  build_pid=
  [ "$st" != 125 ]
}
cleanup() {
  if ! stop_build; then log "BLOCKED: build processes of $new survived SIGKILL; release $rel NOT removed"; return 1; fi
  rm -rf "$rel"
}
blocked() { trap - ERR INT TERM HUP; fail "$1: build processes survived SIGKILL, cleanup BLOCKED; $rel left in place for an operator (the live release is unchanged)"; }
trap 'cleanup || blocked "deploy of $new failed"; fail "deploy of $new failed; release removed, the live release is unchanged"' ERR
trap 'cleanup || blocked "deploy of $new aborted"; fail "deploy of $new aborted; every build process stopped, release removed, the live release is unchanged"' INT TERM HUP
rm -rf "$rel"; install -d -o "$RUN_AS" -g "$(id -gn "$RUN_AS")" "$rel"
as sh -c "git -C '$ROOT/repo' archive '$new' | tar -x -C '$rel'"
# Inside a release (the service account's files) root only deletes whole releases; reading and linking their contents runs
# as the service account, so a symlink planted in the live release reaches nothing that account could not read itself.
[ $reuse = 1 ] && as cp -al "$live/web/node_modules" "$rel/web/node_modules"

# The build runs contained (contain.py, above); a watcher stops it if free space falls to the floor plus the reserve.
# The deploy lock (fd 9) is not inherited: nothing the build starts can hold it.
( set -a; . "$ENV_FILE"; set +a
  exec 9>&-
  exec python3 "$CONTAIN" --grace "$BUILD_GRACE" --kill-wait 10 -- setsid bash -c 'if [ "$(id -un)" = "$0" ]; then exec "$@"; else exec runuser -u "$0" -- "$@"; fi' "$RUN_AS" \
    bash -c "cd '$rel/web' && echo '$new' > .build-commit && $BUILD" ) &
build_pid=$!
low=0; guard=$(( MIN_FREE_BYTES + DISK_RESERVE_BYTES ))
while kill -0 "$build_pid" 2>/dev/null; do
  if [ "$(free_bytes)" -lt "$guard" ]; then low=1; kill -TERM "$build_pid" 2>/dev/null || true; break; fi
  sleep "$WATCH_INTERVAL"
done
status=0; wait "$build_pid" || status=$?
build_pid=
# contain.py has stopped every remaining build process (a normal exit included); 125: one survived, nothing is deleted
[ "$status" != 125 ] || blocked "build of $new"
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
trap - ERR INT TERM HUP

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
  ln -sfn "$prev" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$(basename "$prev")" > "$STATE/release.env"
  $RESTART 9>&- && healthy "$(basename "$prev")"
}
if ! $STOP 9>&-; then
  cleanup
  restart_prev && fail "could not stop the service for a recovery point; nothing migrated, release removed, $(basename "$prev") restarted unchanged"
  [ -n "$prev" ] || fail "could not stop the service for a recovery point; nothing migrated, release removed (first deployment: NO LIVE STAGING SERVICE)"
  # The stop can fail before the app was touched (#836: the scan worker is stopped first, and it would not stop). Say what
  # is true: when the previous release still answers healthy it is live, not gone.
  healthy "$(basename "$prev")" && fail "could not stop the service for a recovery point; nothing migrated, release removed, $(basename "$prev") is still live (it was not restarted)"
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
    ln -sfn "$prev" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$p" > "$STATE/release.env"
    if $RESTART 9>&- && healthy "$p"; then fail "rolled back: $p is live again"; fi
    fail "rollback to $p did not come up healthy: NO LIVE STAGING SERVICE (current points at $p)"
  fi
  # a first deployment has nothing to go back to: leave no pointer at the failed release
  rm -f "$ROOT/current" "$STATE/release.env"
  fail "first deployment failed: NO LIVE STAGING SERVICE (database restored)"
}
trap 'cutover_fail "a cutover step failed"' ERR
ln -sfn "$rel" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$new" > "$STATE/release.env"
$RESTART 9>&- || cutover_fail "the restart command failed" # the service must not inherit the deploy lock
healthy "$new" || cutover_fail "/api/health never answered ok with commit $new"
trap - ERR
clear_pending   # the commit point: from here a crash is NOT rolled back (a retry redeploys this commit over its migrated database)
safe_touch "$rel/.complete"; echo "$new" > "$STATE/current-sha"
log "live: $new"
# The scan worker's state after the cutover, in the journal (#836). A report only: the gate above is the app's health.
if worker_installed; then
  wstate=$($SYSTEMCTL is-active "$WORKER" 2>/dev/null || true)
  if [ "$wstate" = active ]; then log "scan worker: active ($WORKER)"
  elif $SYSTEMCTL is-enabled --quiet "$WORKER"; then log "ALERT scan worker: ${wstate:-unknown} ($WORKER is enabled but not running; scans run on the app only)"
  else log "scan worker: ${wstate:-inactive} ($WORKER is installed but not enabled)"; fi
fi
# Release identity (ops/release-manifest.mjs): the exact commit, build id and readiness the live service reports, in the
# journal and in the release's release.json. A report only; the gate above is /api/health with the commit.
if [ -f "$rel/ops/release-manifest.mjs" ]; then
  if as node "$rel/ops/release-manifest.mjs" write "$rel/web" "$rel/release.json" >/dev/null 2>&1; then
    log "release identity: $(as node "$rel/ops/release-manifest.mjs" check "$rel/release.json" "http://127.0.0.1:$PORT" 2>&1 | tr '\n' ' ')"
  else log "release identity: not recorded (no build output to describe)"; fi
fi
# recovery points: the three newest are kept (the live release's is the newest)
prune_recovery
# keep the live release and the two complete ones before it
ls -1dt "$RELS"/* | while read -r d; do [ ! -L "$d" ] && [ -d "$d" ] && [ -e "$d/.complete" ] && echo "$d"; done | tail -n +4 | xargs -r rm -rf || true
exit 0
