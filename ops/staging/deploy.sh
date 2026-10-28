#!/usr/bin/env bash
# Staging deploy (docs/STAGING.md). Run by dazl-staging-deploy.timer every 2 minutes, as root. When origin/main has a
# new commit it:
#   1. checks the staging env file is safe (check_env: staging only, never production's database, Stripe test mode)
#   2. checks the disk: a new release is started only if free space minus its estimated size stays above the floor
#      (MIN_FREE_BYTES, 2 GiB by default), and the build is stopped if free space falls to the floor while it runs
#   3. builds the commit in its own release directory as the service user, with the env file's values passed in by
#      root (the file itself stays root-only, mode 600), seeds (idempotent), switches `current`, restarts the service
#   4. waits for /api/health to report the new commit; otherwise switches back and restarts the previous release
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
# used when there is no live release to measure: node_modules plus build output, measured at about 1.1 GB
FIRST_RELEASE_BYTES=${FIRST_RELEASE_BYTES:-1200000000}
# Production's database: given as its path, or read from production's env file. Fail closed when neither is known.
PROD_DB_PATH=${PROD_DB_PATH:-}
PROD_ENV_FILE=${PROD_ENV_FILE:-}

log() { echo "staging-deploy: $*"; }
fail() { echo "staging-deploy: $*" >&2; exit 1; }
val() { sed -n "s/^\(export \)\{0,1\}$1=//p" "$2" | tail -n 1 | sed "s/^[\"']//; s/[\"']$//"; }

check_env() {
  local f=$1
  [ -f "$f" ] || fail "env file $f not found"
  [ "$(val DAZL_ENV "$f")" = staging ] || fail "env: DAZL_ENV must be staging"
  [ -z "$(val DATABASE_URL "$f")" ] || fail "env: no DATABASE_URL on staging (its store is its own SQLite file)"
  case "$(val STRIPE_SECRET_KEY "$f")" in sk_test_*|rk_test_*|'') ;; *) fail "env: STRIPE_SECRET_KEY must be a test-mode key";; esac
  case "$(val PUBLIC_BASE_URL "$f")" in https://staging.*) ;; *) fail "env: PUBLIC_BASE_URL must be the staging URL";; esac
  [ -z "$(val GOOGLE_CLIENT_SECRET "$f")" ] || fail "env: no Google credentials on staging (Gmail is stubbed)"
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

if [ "${1:-}" = --check-env ]; then check_env "${2:?usage: deploy.sh --check-env FILE}"; echo "env ok"; exit 0; fi

check_env "$ENV_FILE"
mkdir -p "$ROOT/releases"
exec 9>"$ROOT/.deploy.lock"; flock -n 9 || { log "another deploy is running"; exit 0; }
as() { runuser -u "$RUN_AS" -- "$@"; }
free_bytes() { df -B1 --output=avail "$ROOT" | tail -n 1 | tr -d ' '; }

# leftovers of an interrupted deploy (no completion mark) go first
for d in "$ROOT"/releases/*/; do [ -d "$d" ] && [ ! -e "$d/.complete" ] && [ "$(readlink -f "$ROOT/current" 2>/dev/null)" != "$(readlink -f "$d")" ] && rm -rf "$d"; done

[ -d "$ROOT/repo/.git" ] || as git clone -q --no-checkout "$REPO_URL" "$ROOT/repo"
as git -C "$ROOT/repo" fetch -q origin main
new=$(as git -C "$ROOT/repo" rev-parse origin/main)
cur=$(cat "$ROOT/current-sha" 2>/dev/null || true)
[ "$new" != "$cur" ] || exit 0

live=$(readlink -f "$ROOT/current" 2>/dev/null || true)
reuse=0
if [ -n "$live" ] && [ -d "$live/web/node_modules" ] && as git -C "$ROOT/repo" diff --quiet "$cur" "$new" -- web/package-lock.json 2>/dev/null; then reuse=1; fi
if [ -n "$live" ] && [ -d "$live/web" ]; then
  est=$(du -sb --exclude=node_modules "$live/web" | cut -f1)
  [ $reuse = 1 ] || est=$(( est + $(du -sb "$live/web/node_modules" | cut -f1) ))
else est=$FIRST_RELEASE_BYTES; fi
avail=$(free_bytes)
if [ $(( avail - est )) -lt "$MIN_FREE_BYTES" ]; then
  fail "not deploying $new: $avail bytes free, a release needs about $est, and the floor is $MIN_FREE_BYTES"
fi
log "deploying $new (was ${cur:-none}); $avail bytes free, release about $est"

rel="$ROOT/releases/$new"
build_pid=
cleanup() { [ -n "$build_pid" ] && kill -TERM -- "-$build_pid" 2>/dev/null || true; rm -rf "$rel"; }
trap 'cleanup; fail "deploy of $new failed; release removed, the live release is unchanged"' ERR
rm -rf "$rel"; install -d -o "$RUN_AS" -g "$(id -gn "$RUN_AS")" "$rel"
as sh -c "git -C '$ROOT/repo' archive '$new' | tar -x -C '$rel'"
[ $reuse = 1 ] && cp -al "$live/web/node_modules" "$rel/web/node_modules"

# The build runs in its own process group; a watcher stops it if free space reaches the floor.
( set -a; . "$ENV_FILE"; set +a
  exec setsid runuser -u "$RUN_AS" -- bash -c "cd '$rel/web' && echo '$new' > .build-commit \
    && { [ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error; } \
    && NODE_OPTIONS=--max-old-space-size=2048 nice -n 10 npx next build \
    && rm -rf .next/cache \
    && npm run -s db:migrate \
    && node --experimental-strip-types --no-warnings scripts/staging-seed.mts" ) &
build_pid=$!
low=0
while kill -0 "$build_pid" 2>/dev/null; do
  if [ "$(free_bytes)" -lt "$MIN_FREE_BYTES" ]; then low=1; kill -TERM -- "-$build_pid" 2>/dev/null || true; break; fi
  sleep 2
done
status=0; wait "$build_pid" || status=$?
build_pid=
[ $low = 0 ] || { cleanup; fail "free space reached the floor ($MIN_FREE_BYTES bytes) during the build; release removed"; }
[ $status = 0 ] || { cleanup; fail "build or seed of $new failed (exit $status); release removed"; }
trap - ERR

prev=$live
ln -sfn "$rel" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$new" > "$ROOT/release.env"
$RESTART 9>&- # the service must not inherit the deploy lock
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q "\"commit\":\"$new\""; then
    touch "$rel/.complete"; echo "$new" > "$ROOT/current-sha"
    log "live: $new"
    # keep the live release and the two complete ones before it
    ls -1dt "$ROOT"/releases/*/ | while read -r d; do [ -e "$d/.complete" ] && echo "$d"; done | tail -n +4 | xargs -r rm -rf
    exit 0
  fi
  sleep 2
done
log "health check failed for $new; rolling back"
if [ -n "$prev" ]; then ln -sfn "$prev" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$(basename "$prev")" > "$ROOT/release.env"; $RESTART 9>&-; fi
rm -rf "$rel"
exit 1
