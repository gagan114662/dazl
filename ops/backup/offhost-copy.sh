#!/usr/bin/env bash
# Encrypted off-host copy of one backup (issue #360; docs/RECOVERY.md "Off-host copies"). Only ciphertext leaves the box.
#   OFFHOST_AGE_RECIPIENTS=/etc/dazl-backup/recipients.txt OFFHOST_DEST=<dir | rclone:REMOTE:PATH> \
#   DAZL_TOMBSTONE_LEDGER=/var/lib/dazl-ledger/tombstones.jsonl bash ops/backup/offhost-copy.sh /var/backups/dazl/dazl-backup-<ts>.db
# 1. The backup must have its create-backup sidecar (<backup>.json) and match its sha256; otherwise nothing is copied.
# 2. It is encrypted with age to the PUBLIC keys in OFFHOST_AGE_RECIPIENTS (one per line). The matching private key is
#    kept offline, apart from the host and from DAZL_MASTER_KEY: the host can write copies it cannot read back.
# 3. <name>.age and a manifest <name>.age.json (plaintext and ciphertext sha256, bytes, the backup's createdAt, recipient
#    public keys; no data) go to OFFHOST_DEST:
#      - a directory (a mounted remote, or a second disk for tests): written as .partial, then renamed, then re-hashed;
#      - rclone:REMOTE:PATH (any rclone remote: Cloudflare R2, Backblaze B2, S3, SFTP...): `rclone copyto`, then the
#        uploaded object is read back and its sha256 compared.
#    A copy whose read-back hash differs is a failure (exit 1).
# 4. Then the tombstone ledger (#359; DAZL_TOMBSTONE_LEDGER, the same path the app writes). A restore re-applies tenant
#    deletions from it (docs/RECOVERY.md step 6), so it must survive the host like the backup. A snapshot of it is
#    encrypted the same way and goes to the same destination as dazl-ledger-<utc>.jsonl.age with its manifest
#    (tool dazl-offhost-ledger: sha256s, bytes, line count, the backup it was copied with; the ledger holds tenant ids,
#    times and policies, no tenant data). The backup copy is already in place when this runs, so a ledger failure never
#    costs the backup copy. DAZL_TOMBSTONE_LEDGER unset, or naming no file, is a failure (exit 1): create the file empty
#    when the host is provisioned (`install -m 600 -o <app user> /dev/null <path>`), so a wrong path is never taken for
#    "no deletions". backup-check.mts alerts when the newest ledger copy is older than the newest backup copy.
# Prints one JSON line per copy on success. Exit 0 ok; 1 failed; 2 refused (usage, missing sidecar or recipients,
# plaintext dest).
# Free: age and rclone are open source (apt install age rclone). Storage cost depends on the destination the owner picks.
set -euo pipefail
die() { echo "offhost-copy: $1" >&2; exit "${2:-1}"; }
B=${1:-}; [ -n "$B" ] && [ -f "$B" ] || die "usage: offhost-copy.sh BACKUP_FILE (with its .json sidecar)" 2
R=${OFFHOST_AGE_RECIPIENTS:-}; DEST=${OFFHOST_DEST:-}
[ -n "$R" ] && [ -s "$R" ] || die "OFFHOST_AGE_RECIPIENTS must name a non-empty file of age public keys" 2
grep -q 'AGE-SECRET-KEY' "$R" && die "OFFHOST_AGE_RECIPIENTS holds a private key: give it public keys (age1...) only" 2
[ -n "$DEST" ] || die "OFFHOST_DEST must be a directory or rclone:REMOTE:PATH" 2
command -v age >/dev/null || die "age is not installed (apt install age)" 2
[ -f "$B.json" ] || die "no sidecar $B.json: only create-backup.ts backups are copied" 2
want=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sha256||"")' "$B.json")
created=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).createdAt||"")' "$B.json")
got=$(sha256sum -- "$B" | cut -d' ' -f1)
[ -n "$want" ] && [ "$got" = "$want" ] || die "backup does not match its sidecar sha256: not copied"
case "$DEST" in
  rclone:*) command -v rclone >/dev/null || die "rclone is not installed (apt install rclone)" 2 ;;
  *)
    [ -d "$DEST" ] || die "OFFHOST_DEST $DEST is not a directory" 2
    [ "$(realpath -- "$DEST")" != "$(realpath -- "$(dirname -- "$B")")" ] || die "OFFHOST_DEST is the backup directory itself: not off-host" 2 ;;
esac

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; chmod 700 "$tmp"
recips=$(grep -E '^age1[0-9a-z]+$' "$R" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8").trim().split("\n").filter(Boolean)))')
# seal PLAINTEXT NAME: encrypts to $tmp/NAME; sets ct (its sha256) and bytes
seal() {
  age -R "$R" -o "$tmp/$2" -- "$1"
  head -c 16 "$tmp/$2" | grep -q 'age-encryption' || die "age output is not an age file"
  ct=$(sha256sum -- "$tmp/$2" | cut -d' ' -f1); bytes=$(wc -c < "$tmp/$2" | tr -d ' ')
}
# put NAME: $tmp/NAME and its manifest $tmp/NAME.json go to OFFHOST_DEST; the ciphertext is read back and must hash to
# $ct. Sets where.
put() {
  local back r
  case "$DEST" in
    rclone:*)
      r=${DEST#rclone:}; r=${r%/}
      rclone copyto "$tmp/$1" "$r/$1" && rclone copyto "$tmp/$1.json" "$r/$1.json"
      back=$(rclone cat "$r/$1" | sha256sum | cut -d' ' -f1)
      where="$r/$1" ;;
    *)
      install -m 600 "$tmp/$1" "$DEST/$1.partial" && mv -f "$DEST/$1.partial" "$DEST/$1"
      install -m 600 "$tmp/$1.json" "$DEST/$1.json.partial" && mv -f "$DEST/$1.json.partial" "$DEST/$1.json"
      back=$(sha256sum -- "$DEST/$1" | cut -d' ' -f1)
      where="$DEST/$1" ;;
  esac
  [ "$back" = "$ct" ] || die "read-back sha256 of $where differs from what was written"
}

name=$(basename -- "$B").age
seal "$B" "$name"
printf '{"tool":"dazl-offhost-copy","source":"%s","source_sha256":"%s","source_created_at":"%s","ciphertext":"%s","ciphertext_sha256":"%s","bytes":%s,"recipients":%s,"copied_at":"%s"}\n' \
  "$(basename -- "$B")" "$got" "$created" "$name" "$ct" "$bytes" "$recips" "$(date -u +%FT%TZ)" > "$tmp/$name.json"
put "$name"
printf '{"level":"info","type":"offhost_copy","ok":true,"to":"%s","ciphertext_sha256":"%s","bytes":%s}\n' "$where" "$ct" "$bytes"

# 4. the tombstone ledger, after the backup copy is in place (so its copied_at is never older than the backup's)
L=${DAZL_TOMBSTONE_LEDGER:-}
[ -n "$L" ] || die "DAZL_TOMBSTONE_LEDGER is not set: the deletion ledger was not copied off-host (set it to the app's ledger path)"
[ -f "$L" ] || die "DAZL_TOMBSTONE_LEDGER names no file: the deletion ledger was not copied (create it empty at provisioning)"
cp -- "$L" "$tmp/ledger.jsonl" # one snapshot: the app may append meanwhile; every hash and the ciphertext are of this copy
lsha=$(sha256sum -- "$tmp/ledger.jsonl" | cut -d' ' -f1); lines=$(grep -c . "$tmp/ledger.jsonl" || true)
at=$(date -u +%FT%TZ); lname="dazl-ledger-$(date -u +%Y%m%dT%H%M%SZ).jsonl.age"
seal "$tmp/ledger.jsonl" "$lname"
printf '{"tool":"dazl-offhost-ledger","source_sha256":"%s","lines":%s,"with_backup":"%s","ciphertext":"%s","ciphertext_sha256":"%s","bytes":%s,"recipients":%s,"copied_at":"%s"}\n' \
  "$lsha" "$lines" "$(basename -- "$B")" "$lname" "$ct" "$bytes" "$recips" "$at" > "$tmp/$lname.json"
put "$lname"
printf '{"level":"info","type":"offhost_ledger_copy","ok":true,"to":"%s","ciphertext_sha256":"%s","bytes":%s,"lines":%s}\n' "$where" "$ct" "$bytes" "$lines"
