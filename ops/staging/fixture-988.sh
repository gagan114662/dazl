#!/usr/bin/env bash
# #988 host wrapper for the staging sample-data tool (scripts/staging-fixture-988*.mts). REVIEWED, NEVER AUTO-RUN. It binds the tool to the real staging file and holds ONE writer lock from the
# snapshot to the independent after-proof. It does not stop the service (that is a host change for the operator): it REFUSES unless the service is already stopped and no process has the database open.
#
#   sudo ops/staging/fixture-988.sh plan                    # dry-run package: bindings + prepare (snapshot, backup, restore proof) + the tool's dry-run plan; writes nothing to the database
#   sudo APPLY_TENANT_ID=<id from the plan> ops/staging/fixture-988.sh apply   # prepare, apply (exactly 1 run + 4 leads or nothing), then the independent after-proof
#
# Required environment: PROD_DB_PATH (production's database, to prove it is a different file). Optional: STAGING_ROOT (/srv/dazl-staging), STAGING_SERVICE (dazl-staging.service),
# STAGING_USER (dazl-staging), STAGING_STATE_ROOT (/var/lib/dazl-staging-deploy), FIXTURE_OUT_ROOT (/var/lib/dazl-staging-recovery/fixture-988).
set -euo pipefail
umask 077
MODE=${1:-}; [ "$MODE" = plan ] || [ "$MODE" = apply ] || { echo "usage: $0 plan|apply" >&2; exit 2; }
fail() { echo "fixture-988: REFUSED: $*" >&2; exit 3; }
STAGING_DB=/var/lib/dazl-staging/app.db            # the ONE database; the tool enforces the same constant
ROOT=${STAGING_ROOT:-/srv/dazl-staging}; SERVICE=${STAGING_SERVICE:-dazl-staging.service}; RUN_AS=${STAGING_USER:-dazl-staging}
STATE=${STAGING_STATE_ROOT:-/var/lib/dazl-staging-deploy}; OUT_ROOT=${FIXTURE_OUT_ROOT:-/var/lib/dazl-staging-recovery/fixture-988}
[ "$(id -u)" = 0 ] || fail "run as root"
[ -n "${PROD_DB_PATH:-}" ] || fail "PROD_DB_PATH is required (to prove the production file is a different file)"
[ -f "$STAGING_DB" ] || fail "$STAGING_DB does not exist; this tool never creates a database"
[ "$(realpath -e -- "$STAGING_DB")" = "$STAGING_DB" ] || fail "$STAGING_DB resolves elsewhere (symlink)"

# ONE lock for the whole sequence, the same one the staging deploy timer takes, so a deploy cannot start in the middle.
mkdir -p "$STATE"; exec 9>"$STATE/.deploy.lock"; flock -n 9 || fail "a deploy (or another fixture run) holds the lock"

# identity of the staging file (device:inode, one hard link) and of production's, which must differ
S_ID=$(stat -Lc '%d:%i' -- "$STAGING_DB"); S_LINKS=$(stat -Lc '%h' -- "$STAGING_DB")
[ "$S_LINKS" = 1 ] || fail "$STAGING_DB has $S_LINKS hard links"
if [ -e "$PROD_DB_PATH" ]; then P_ID=$(stat -Lc '%d:%i' -- "$PROD_DB_PATH"); [ "$S_ID" != "$P_ID" ] || fail "the staging file IS the production file"; else P_ID=; fi
case "$(realpath -m -- "$PROD_DB_PATH")" in "$STAGING_DB"|"$STAGING_DB"-*) fail "PROD_DB_PATH names the staging database";; esac

# no writers: the service is stopped and nothing has the database, its WAL or its shm open
systemctl is-active --quiet "$SERVICE" && fail "$SERVICE is running; stop it first (operator step), then re-run"
for f in "$STAGING_DB" "$STAGING_DB-wal" "$STAGING_DB-shm"; do [ -e "$f" ] || continue; if fuser -s -- "$f" 2>/dev/null; then fail "a process has $f open"; fi; done

# release / QA workspace binding: the code being run is the checked-out release, and it is clean
[ -d "$ROOT/web" ] || fail "no release at $ROOT/web"
REL=$(git -C "$ROOT" rev-parse HEAD); git -C "$ROOT" diff --quiet -- web/scripts web/lib || fail "the release tree has local changes"
echo "release=$REL staging_identity=$S_ID production_identity=${P_ID:-none} service=stopped writers=none"

RUN() { runuser -u "$RUN_AS" -- env DAZL_ENV=staging DB_PATH="$STAGING_DB" DAZL_STAGING_REAL_GMAIL=0 DAZL_FIXTURE_DB_IDENTITY="$S_ID" DAZL_FIXTURE_PROD_DB_IDENTITY="$P_ID" \
  node --experimental-strip-types --no-warnings "$ROOT/web/scripts/$1" "${@:2}"; }

mkdir -p "$OUT_ROOT"; chmod 700 "$OUT_ROOT"
DIR="$OUT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"                      # new directory; the tool refuses an existing one and creates every file exclusively, 0600
echo "== 1. prepare: file hash, snapshot, backup, restore proof, file hash again -> $DIR"
RUN staging-fixture-988-checks.mts prepare --dir="$DIR"
echo "== 2. the tool's dry-run plan (exact tenant, expected changes)"
RUN staging-fixture-988.mts
[ "$MODE" = apply ] || { echo "plan only: nothing was written to the database. Backup and snapshot are in $DIR"; exit 0; }
[ -n "${APPLY_TENANT_ID:-}" ] || fail "APPLY_TENANT_ID is required to apply"
echo "== 3. apply (one transaction, exactly 1 run + 4 leads or nothing)"
RUN staging-fixture-988.mts --apply --tenant-id="$APPLY_TENANT_ID"
echo "== 4. independent after-proof against the SAME snapshot (read-only)"
RUN staging-fixture-988-checks.mts after --snapshot="$DIR/snapshot.json"
echo "done. The lock was held throughout; the service is still stopped (starting it again is the operator's step). Restore, if ever needed, is a manual copy of $DIR/backup.db with the service stopped."
