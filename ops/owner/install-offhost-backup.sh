#!/bin/bash
# Step 2 of the off-host backup (issue #1080). Run from the owner's Mac after ops/backup/aws-setup.sh.
#
#   DAZL_SSH_HOST=<ssh alias or user@host of the box> ops/owner/install-offhost-backup.sh [key file]
#
# The key file is the upload-only .s3.env that aws-setup.sh wrote; when it is not given, the only *.s3.env in
# ~/dazl-backup-keys is used.
# 1. copies the key file to the server (the secret is never printed)
# 2. runs the repo's installer from the LIVE production release: hourly backup timer, one backup now,
#    a freshness check against the bucket, and a restore test of the snapshot just uploaded
# 3. removes the copied key file from the server's home folder (the installer keeps its own root-only copy)
# Safe to run again. To undo: sudo systemctl disable --now 'dazl-backup*.timer' on the server.
set -euo pipefail
: "${DAZL_SSH_HOST:?set DAZL_SSH_HOST to the ssh alias or user@host of the box}"
KEYFILE="${1:-}"
if [ -z "$KEYFILE" ]; then
  shopt -s nullglob
  found=("$HOME"/dazl-backup-keys/*.s3.env)
  [ "${#found[@]}" = 1 ] || { echo "expected one *.s3.env in ~/dazl-backup-keys, found ${#found[@]}: pass the key file as the first argument (ops/backup/aws-setup.sh makes it)" >&2; exit 1; }
  KEYFILE="${found[0]}"
fi
[ -f "$KEYFILE" ] || { echo "missing $KEYFILE (run ops/backup/aws-setup.sh first)" >&2; exit 1; }
SSH=(-o ConnectTimeout=15 -o BatchMode=yes)
scp -q "${SSH[@]}" -- "$KEYFILE" "$DAZL_SSH_HOST:dazl-backup.s3.env"
echo "key file copied to the server"
ssh "${SSH[@]}" -- "$DAZL_SSH_HOST" 'bash -s' <<'EOF'
set -euo pipefail
K="$HOME/dazl-backup.s3.env"
chmod 600 "$K"
REL=$(for d in $(sudo sed -n 's/^DAZL_RELEASE=//p' /etc/dazl-prod/ports/*.conf); do [ -f "$d/ops/backup/install-prod-offhost.sh" ] && echo "$d"; done | head -1)
[ -n "$REL" ] || { echo "FAIL: no live release contains ops/backup/install-prod-offhost.sh"; rm -f "$K"; exit 1; }
echo "installer from: $REL"
set +e
sudo bash "$REL/ops/backup/install-prod-offhost.sh" --credentials "$K" 2>&1 | sed -E 's/(AWS_SECRET_ACCESS_KEY=).*/\1<hidden>/'
RC=${PIPESTATUS[0]}
set -e
rm -f "$K"
echo "--- timers ---"
systemctl list-timers --no-pager | grep -i backup || echo "no backup timer listed"
exit "$RC"
EOF
