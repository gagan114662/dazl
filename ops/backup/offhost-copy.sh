#!/usr/bin/env bash
# Encrypted off-host copy of one backup (issue #360; docs/RECOVERY.md "Off-host copies"). Only ciphertext leaves the box.
#   OFFHOST_AGE_RECIPIENTS=/etc/dazl-backup/recipients.txt OFFHOST_DEST=<dir | rclone:REMOTE:PATH> \
#     bash ops/backup/offhost-copy.sh /var/backups/dazl/dazl-backup-<ts>.db
# 1. The backup must have its create-backup sidecar (<backup>.json) and match its sha256; otherwise nothing is copied.
# 2. It is encrypted with age to the PUBLIC keys in OFFHOST_AGE_RECIPIENTS (one per line). The matching private key is
#    kept offline, apart from the host and from DAZL_MASTER_KEY: the host can write copies it cannot read back.
# 3. <name>.age and a manifest <name>.age.json (plaintext and ciphertext sha256, bytes, the backup's createdAt, recipient
#    public keys; no data) go to OFFHOST_DEST:
#      - a directory (a mounted remote, or a second disk for tests): written as .partial, then renamed, then re-hashed;
#      - rclone:REMOTE:PATH (any rclone remote: Cloudflare R2, Backblaze B2, S3, SFTP...): `rclone copyto`, then the
#        uploaded object is read back and its sha256 compared.
#    A copy whose read-back hash differs is a failure (exit 1).
# Prints one JSON line on success. Exit 0 ok; 1 failed; 2 refused (usage, missing sidecar or recipients, plaintext dest).
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

name=$(basename -- "$B").age
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; chmod 700 "$tmp"
age -R "$R" -o "$tmp/$name" -- "$B"
head -c 16 "$tmp/$name" | grep -q 'age-encryption' || die "age output is not an age file"
ct=$(sha256sum -- "$tmp/$name" | cut -d' ' -f1); bytes=$(stat -c %s -- "$tmp/$name")
recips=$(grep -E '^age1[0-9a-z]+$' "$R" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8").trim().split("\n").filter(Boolean)))')
printf '{"tool":"dazl-offhost-copy","source":"%s","source_sha256":"%s","source_created_at":"%s","ciphertext":"%s","ciphertext_sha256":"%s","bytes":%s,"recipients":%s,"copied_at":"%s"}\n' \
  "$(basename -- "$B")" "$got" "$created" "$name" "$ct" "$bytes" "$recips" "$(date -u +%FT%TZ)" > "$tmp/$name.json"

case "$DEST" in
  rclone:*)
    command -v rclone >/dev/null || die "rclone is not installed (apt install rclone)" 2
    r=${DEST#rclone:}; r=${r%/}
    rclone copyto "$tmp/$name" "$r/$name" && rclone copyto "$tmp/$name.json" "$r/$name.json"
    back=$(rclone cat "$r/$name" | sha256sum | cut -d' ' -f1)
    where="$r/$name" ;;
  *)
    [ -d "$DEST" ] || die "OFFHOST_DEST $DEST is not a directory" 2
    [ "$(realpath -- "$DEST")" != "$(realpath -- "$(dirname -- "$B")")" ] || die "OFFHOST_DEST is the backup directory itself: not off-host" 2
    install -m 600 "$tmp/$name" "$DEST/$name.partial" && mv -f "$DEST/$name.partial" "$DEST/$name"
    install -m 600 "$tmp/$name.json" "$DEST/$name.json.partial" && mv -f "$DEST/$name.json.partial" "$DEST/$name.json"
    back=$(sha256sum -- "$DEST/$name" | cut -d' ' -f1)
    where="$DEST/$name" ;;
esac
[ "$back" = "$ct" ] || die "read-back sha256 of $where differs from what was written"
printf '{"level":"info","type":"offhost_copy","ok":true,"to":"%s","ciphertext_sha256":"%s","bytes":%s}\n' "$where" "$ct" "$bytes"
