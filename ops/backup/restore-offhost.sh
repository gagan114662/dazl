#!/usr/bin/env bash
# Restores the NEWEST off-host backup copy into a new private directory and proves it (issue #1080): the restore half
# of ops/backup/offhost-copy.sh. Changes nothing anywhere else: it never touches the live database or the destination.
#   bash ops/backup/restore-offhost.sh --offhost <dir | rclone:REMOTE:PATH> --identity <age private key file> \
#        --out <new directory> [--compare <a database to compare row counts with, opened read-only>]
# Steps, each timed:
#   1. fetch    the newest dazl-backup-*.db.age (by its manifest's copied_at) and its manifest; the ciphertext must
#               have the manifest's bytes and sha256
#   2. decrypt  age -d with the identity (the private key kept OFFLINE, apart from the host); the plaintext must hash
#               to the manifest's source_sha256, i.e. it is byte for byte the backup the host took
#   3. verify   PRAGMA integrity_check = ok; row counts of users, scan_jobs and leads (and of --compare, side by side)
# Prints one JSON line: the restored file, the backup's createdAt, rpo_s (now minus createdAt: what losing the host
# now would lose), restore_ms (fetch + decrypt + verify) and the counts. Exit 0 = restored and verified; 1 = a step
# failed (named); 2 = refused (usage, --out exists, identity readable by others). No key material, no row data printed.
# For the full replacement-host drill (app started on the copy, secrets decrypted): scripts/backup/replacement-drill.mts.
set -euo pipefail
die() { echo "restore-offhost: $1" >&2; exit "${2:-1}"; }
DEST=; ID=; OUT=; CMP=
while [ $# -gt 0 ]; do
  case "$1" in
    --offhost|--identity|--out|--compare) [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" 2
      case "$1" in --offhost) DEST=$2 ;; --identity) ID=$2 ;; --out) OUT=$2 ;; --compare) CMP=$2 ;; esac; shift 2 ;;
    *) die "unknown option $1" 2 ;;
  esac
done
[ -n "$DEST" ] && [ -n "$ID" ] && [ -n "$OUT" ] || die "usage: restore-offhost.sh --offhost DEST --identity FILE --out NEW_DIR [--compare DB]" 2
[ -f "$ID" ] || die "--identity $ID is not a file" 2
[ "$(( 0$(stat -c %a -- "$ID") & 077 ))" = 0 ] || die "--identity $ID is readable by others (chmod 600)" 2
[ ! -e "$OUT" ] || die "--out $OUT already exists: give a new directory" 2
[ -z "$CMP" ] || [ -f "$CMP" ] || die "--compare $CMP is not a file" 2
for c in age sqlite3 python3 sha256sum; do command -v "$c" >/dev/null || die "$c is not installed" 2; done
case "$DEST" in rclone:*) command -v rclone >/dev/null || die "rclone is not installed" 2; R=${DEST#rclone:}; R=${R%/} ;; *) [ -d "$DEST" ] || die "--offhost $DEST is not a directory" 2 ;; esac
ms() { date +%s%3N; }
t0=$(ms)
mkdir -m 700 -- "$OUT"
list() { case "$DEST" in rclone:*) rclone lsf --files-only --include 'dazl-backup-*.db.age.json' "$R" ;; *) find "$DEST" -maxdepth 1 -name 'dazl-backup-*.db.age.json' -printf '%f\n' ;; esac; }
get() { case "$DEST" in rclone:*) rclone copyto "$R/$1" "$OUT/$1" ;; *) cp -- "$DEST/$1" "$OUT/$1" ;; esac; }

# 1. fetch: every manifest is small; the newest by copied_at wins (a name alone is not trusted)
mapfile -t manifests < <(list | sort)
[ "${#manifests[@]}" -gt 0 ] || die "no dazl-backup-*.db.age.json manifest at the destination"
for m in "${manifests[@]}"; do [[ $m =~ ^dazl-backup-[0-9A-Za-z._-]+\.db\.age\.json$ ]] || die "unexpected manifest name: $m"; get "$m"; done
read -r name want_ct want_bytes want_src created < <(python3 - "$OUT" "${manifests[@]}" <<'PY'
import json, sys, datetime
out, best = sys.argv[1], None
now = datetime.datetime.now(datetime.timezone.utc)
for m in sys.argv[2:]:
    try: d = json.load(open(f'{out}/{m}'))
    except Exception: continue
    if d.get('tool') != 'dazl-offhost-copy' or d.get('ciphertext') != m[:-5]: continue
    try: at = datetime.datetime.fromisoformat(d['copied_at'].replace('Z', '+00:00'))
    except Exception: continue
    if at > now + datetime.timedelta(minutes=5): continue   # a copy from the future is not the newest
    if best is None or at > best[0]: best = (at, d)
if best is None: sys.exit(3)
d = best[1]
print(d['ciphertext'], d['ciphertext_sha256'], d['bytes'], d['source_sha256'], d.get('source_created_at') or '-')
PY
) || die "no readable dazl-offhost-copy manifest at the destination"
[[ $name =~ ^dazl-backup-[0-9A-Za-z._-]+\.db\.age$ ]] || die "the manifest names an unexpected ciphertext"
get "$name"
[ "$(wc -c < "$OUT/$name" | tr -d ' ')" = "$want_bytes" ] || die "fetched $name has the wrong size"
[ "$(sha256sum -- "$OUT/$name" | cut -d' ' -f1)" = "$want_ct" ] || die "fetched $name does not match its manifest sha256"
t1=$(ms)

# 2. decrypt
db=$OUT/${name%.age}
age -d -i "$ID" -o "$db" -- "$OUT/$name" || die "age could not decrypt $name with this identity"
chmod 600 -- "$db"
[ "$(sha256sum -- "$db" | cut -d' ' -f1)" = "$want_src" ] || die "the decrypted backup does not match the manifest's source_sha256"
t2=$(ms)

# 3. verify
[ "$(sqlite3 "file:$db?mode=ro" 'PRAGMA integrity_check' 2>&1)" = ok ] || die "integrity_check failed on the restored database"
counts() { sqlite3 "file:$1?mode=ro" "select '{\"users\":'||(select count(*) from users)||',\"scan_jobs\":'||(select count(*) from scan_jobs)||',\"leads\":'||(select count(*) from leads)||'}'"; }
rc=$(counts "$db") || die "the restored database has no users / scan_jobs / leads tables"
cc=null; same=null
if [ -n "$CMP" ]; then cc=$(counts "$CMP") || die "--compare has no users / scan_jobs / leads tables"; [ "$cc" = "$rc" ] && same=true || same=false; fi
t3=$(ms)
rpo=null
if [ "$created" != - ]; then rpo=$(python3 -c 'import sys,datetime;print(int((datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00"))).total_seconds()))' "$created") || rpo=null; fi
printf '{"type":"offhost_restore","ok":true,"restored":"%s","backup_created_at":"%s","rpo_s":%s,"restore_ms":%s,"fetch_ms":%s,"decrypt_ms":%s,"verify_ms":%s,"integrity":"ok","rows":%s,"compare_rows":%s,"rows_match":%s}\n' \
  "$db" "$created" "$rpo" "$((t3-t0))" "$((t1-t0))" "$((t2-t1))" "$((t3-t2))" "$rc" "$cc" "$same"
[ "$same" != false ] || die "row counts differ from --compare (see the line above)"
