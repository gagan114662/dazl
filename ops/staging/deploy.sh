#!/usr/bin/env bash
# Staging deploy (docs/STAGING.md). Run by dazl-staging-deploy.timer every 2 minutes, as root. It:
#   1. checks the staging env file is safe (see check_env below)
#   2. if origin/main has a new commit: builds it in its own release directory as the dazl-staging user, runs the
#      staging seed (idempotent), points `current` at it and restarts dazl-staging.service
#   3. waits for /api/health on the staging port to report the new commit; if it does not within 120 s, points
#      `current` back at the previous release and restarts it
# Usage: deploy.sh            deploy origin/main if it changed
#        deploy.sh --check-env FILE   only validate an env file (exit 0 = safe)
# Never touches production: its own directory, user, port, service, database and env file.
set -euo pipefail

ROOT=${STAGING_ROOT:-/srv/dazl-staging}
ENV_FILE=${STAGING_ENV_FILE:-/etc/dazl-staging/env}
PORT=${STAGING_PORT:-3200}
SERVICE=${STAGING_SERVICE:-dazl-staging.service}
RUN_AS=${STAGING_USER:-dazl-staging}
REPO_URL=${STAGING_REPO_URL:-https://github.com/gagan114662/dazl.git}
PROD_DB=${PROD_DB_PATH:-/var/lib/dazl-next/app.db}

log() { echo "staging-deploy: $*"; }
fail() { echo "staging-deploy: $*" >&2; exit 1; }

# The env file must be a staging env file: DAZL_ENV=staging, its own database (never production's), Stripe in test
# mode only, and the staging URL. Values are read, never printed.
check_env() {
  local f=$1
  [ -f "$f" ] || fail "env file $f not found"
  val() { sed -n "s/^\(export \)\{0,1\}$1=//p" "$f" | tail -n 1 | sed "s/^[\"']//; s/[\"']$//"; }
  [ "$(val DAZL_ENV)" = staging ] || fail "env: DAZL_ENV must be staging"
  local db; db=$(val DB_PATH)
  [ -n "$db" ] || fail "env: DB_PATH is required"
  [ "$db" != "$PROD_DB" ] || fail "env: DB_PATH is the production database"
  case "$db" in /var/lib/dazl-next/*|*/dazl-data/*) fail "env: DB_PATH is inside a production data directory";; esac
  case "$(val STRIPE_SECRET_KEY)" in sk_test_*|rk_test_*|'') ;; *) fail "env: STRIPE_SECRET_KEY must be a test-mode key";; esac
  case "$(val PUBLIC_BASE_URL)" in https://staging.*) ;; *) fail "env: PUBLIC_BASE_URL must be the staging URL";; esac
  [ "$(val GOOGLE_CLIENT_SECRET)" = "" ] || fail "env: no Google credentials on staging (Gmail is stubbed)"
  return 0
}

if [ "${1:-}" = --check-env ]; then check_env "${2:?usage: deploy.sh --check-env FILE}"; echo "env ok"; exit 0; fi

check_env "$ENV_FILE"
exec 9>"$ROOT/.deploy.lock"; flock -n 9 || { log "another deploy is running"; exit 0; }
as() { runuser -u "$RUN_AS" -- "$@"; }

[ -d "$ROOT/repo/.git" ] || as git clone -q --no-checkout "$REPO_URL" "$ROOT/repo"
as git -C "$ROOT/repo" fetch -q origin main
new=$(as git -C "$ROOT/repo" rev-parse origin/main)
cur=$(cat "$ROOT/current-sha" 2>/dev/null || true)
[ "$new" != "$cur" ] || exit 0
log "deploying $new (was ${cur:-none})"

rel="$ROOT/releases/$new"
rm -rf "$rel"; as mkdir -p "$rel"
as sh -c "git -C '$ROOT/repo' archive '$new' | tar -x -C '$rel'"
# the build and the seed see the staging env (DAZL_ENV=staging is baked into the pages at build time)
as bash -c "set -a; . '$ENV_FILE'; set +a; cd '$rel/web' && echo '$new' > .build-commit \
  && npm ci --no-audit --no-fund --loglevel=error \
  && NODE_OPTIONS=--max-old-space-size=2048 nice -n 10 npx next build \
  && npm run -s db:migrate \
  && node --experimental-strip-types --no-warnings scripts/staging-seed.mts"
echo "DAZL_COMMIT_SHA=$new" > "$ROOT/release.env"

prev=$(readlink "$ROOT/current" 2>/dev/null || true)
ln -sfn "$rel" "$ROOT/current"
systemctl restart "$SERVICE"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q "\"commit\":\"$new\""; then
    echo "$new" > "$ROOT/current-sha"
    log "live: $new"
    # keep the three newest releases
    ls -1dt "$ROOT"/releases/*/ | tail -n +4 | xargs -r rm -rf
    exit 0
  fi
  sleep 2
done
log "health check failed for $new; rolling back"
if [ -n "$prev" ]; then ln -sfn "$prev" "$ROOT/current"; echo "DAZL_COMMIT_SHA=$(basename "$prev")" > "$ROOT/release.env"; systemctl restart "$SERVICE"; fi
exit 1
