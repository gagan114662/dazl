#!/bin/bash
# Resets the free-trial search count of ONE test account on STAGING only, so a live check can be rerun.
# Run from the owner's Mac; nobody else has the ssh access.
#
#   DAZL_SSH_HOST=<ssh alias or user@host of the box> ops/owner/reset-staging-trial.sh <test account email>
#
# On the box it first saves the rows it removes to a root-only file, then deletes that account's rows from
# trial_reservations in the STAGING database. Production is never touched: the database path is fixed to the staging
# one and the script stops when it is missing. The account's searches and leads stay as they are.
# To undo: run the saved /root/trial-reset-<time>.sql against the same database.
set -euo pipefail
EMAIL=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
# Letters, digits and . _ + - only: the address goes into a remote command and an SQL string.
[[ "$EMAIL" =~ ^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "usage: DAZL_SSH_HOST=<host> $0 <test account email>" >&2; exit 2; }
: "${DAZL_SSH_HOST:?set DAZL_SSH_HOST to the ssh alias or user@host of the box}"
ssh -o ConnectTimeout=15 -o BatchMode=yes -- "$DAZL_SSH_HOST" "sudo bash -s -- $EMAIL" <<'EOF'
set -euo pipefail
P=/var/lib/dazl-staging/app.db
[ -f "$P" ] || { echo "FAIL: $P not found; nothing changed"; exit 1; }
E=$1
[[ "$E" =~ ^[a-z0-9._+-]+@[a-z0-9.-]+$ ]] || { echo "FAIL: bad email; nothing changed"; exit 1; }
N=$(sqlite3 -readonly "$P" "SELECT count(*) FROM users WHERE lower(email)='$E';")
[ "$N" = 1 ] || { echo "FAIL: expected exactly one staging account for that email, found $N; nothing changed"; exit 1; }
W="tenant_id IN (SELECT id FROM users WHERE lower(email)='$E')"
echo "trial rows before: $(sqlite3 -readonly "$P" "SELECT count(*) FROM trial_reservations WHERE $W;") (all accounts: $(sqlite3 -readonly "$P" "SELECT count(*) FROM trial_reservations;"))"
B=/root/trial-reset-$(date -u +%Y%m%dT%H%M%S).sql
sqlite3 -readonly "$P" ".mode insert trial_reservations" "SELECT * FROM trial_reservations WHERE $W;" > "$B"; chmod 600 "$B"
echo "removed rows saved to $B"
sqlite3 "$P" "PRAGMA busy_timeout=5000; DELETE FROM trial_reservations WHERE $W; SELECT 'rows removed: ' || changes();" | tail -1
echo "trial rows after: $(sqlite3 -readonly "$P" "SELECT count(*) FROM trial_reservations WHERE $W;") (all accounts: $(sqlite3 -readonly "$P" "SELECT count(*) FROM trial_reservations;"))"
EOF
