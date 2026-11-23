#!/usr/bin/env bash
# Restores the NEWEST encrypted backup copy from the S3 bucket into a new private directory and proves it (issue #1080;
# ops/backup/README.md "Restore"). This is the restore drill, and the first step of a real recovery (docs/RECOVERY.md).
# Run by the OWNER on her own machine (macOS or Linux), with her own AWS CLI login and the age PRIVATE key. Never on
# the production box: the box has neither the private key nor permission to read the bucket, by design.
#
#   bash ops/backup/restore-s3.sh --bucket dazl-prod-backups-<account id> \
#        --identity ~/dazl-backup-keys/dazl-offhost-identity.txt --out ~/dazl-restore-test
#
# Steps:
#   1. find      the newest <prefix>/dazl-backup-*.db.age in the bucket (by S3's own LastModified) and download it with
#                its manifest (and the newest deletion-ledger copy, when there is one). Read-only: nothing in the
#                bucket is changed.
#   2. check     the downloaded ciphertext has the manifest's size and sha256
#   3. decrypt   age -d with the identity; the plaintext must hash to the manifest's source_sha256: byte for byte the
#                snapshot the box took
#   4. verify    PRAGMA integrity_check must answer ok; row counts of users, scan_jobs and leads are printed
# Prints PASS or FAIL per step and, on success, where the database file is and how old the backup is. Exit 0 = restored
# and verified; 1 = a step failed (named; no plaintext is left behind); 2 = usage. No key and no row data is printed.
# The restored file is a full copy of production: it is written mode 600 in a mode-700 directory; delete it after a drill.
# Options:
#   --bucket NAME     the bucket (required unless --from-dir)        --prefix P   (prod)      --region R (ca-central-1)
#   --identity FILE   the age private key, mode 600 (required)       --out DIR    a directory that does not exist yet (required)
#   --from-dir DIR    no AWS at all: restore from copies already downloaded into DIR (also what the tests use)
#   --dry-run         print the AWS calls and steps; download and write nothing
set -euo pipefail
die() { echo "restore-s3: $1" >&2; exit "${2:-1}"; }
BUCKET=; PREFIX=prod; REGION=ca-central-1; ID=; OUT=; FROM=; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bucket|--prefix|--region|--identity|--out|--from-dir) [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" 2
      case "$1" in --bucket) BUCKET=$2 ;; --prefix) PREFIX=$2 ;; --region) REGION=$2 ;; --identity) ID=$2 ;; --out) OUT=$2 ;; --from-dir) FROM=$2 ;; esac; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" 2 ;;
  esac
done
[ -n "$ID" ] && [ -n "$OUT" ] && { [ -n "$BUCKET" ] || [ -n "$FROM" ]; } || die "usage: restore-s3.sh --bucket NAME --identity FILE --out NEW_DIR [--prefix P] [--region R] [--from-dir DIR] [--dry-run]" 2
[ -z "$BUCKET" ] || [[ $BUCKET =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || die "--bucket '$BUCKET' is not a bucket name" 2
[[ $PREFIX =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "--prefix must be one plain name" 2
[ -z "$FROM" ] || [ -d "$FROM" ] || die "--from-dir $FROM is not a directory" 2

if [ "$DRY" = 1 ]; then
  echo "restore-s3: DRY RUN: nothing is downloaded or written. A real run does this:"
  if [ -z "$FROM" ]; then
    echo "  aws s3api list-objects-v2 --bucket $BUCKET --prefix $PREFIX/dazl- --region $REGION --output json"
    echo "  aws s3api get-object --bucket $BUCKET --key $PREFIX/<newest>.db.age --region $REGION $OUT/<newest>.db.age"
    echo "  aws s3api get-object --bucket $BUCKET --key $PREFIX/<newest>.db.age.json --region $REGION $OUT/<newest>.db.age.json"
  else echo "  copy the newest dazl-backup-*.db.age and its .json from $FROM to $OUT"; fi
  echo "  check size and sha256 against the manifest; age -d -i $ID; check the plaintext sha256; PRAGMA integrity_check"
  exit 0
fi
[ -f "$ID" ] || die "--identity $ID is not a file" 2
perm() { stat -c %a -- "$1" 2>/dev/null || stat -f %Lp -- "$1"; }
[ "$(( 0$(perm "$ID") & 077 ))" = 0 ] || die "--identity $ID can be read by other users (chmod 600 it)" 2
[ ! -e "$OUT" ] || die "--out $OUT already exists: give a directory that does not exist yet" 2
for c in age python3; do command -v "$c" >/dev/null || die "$c is not installed" 2; done
[ -n "$FROM" ] || command -v aws >/dev/null || die "the AWS CLI is not installed (or use --from-dir with copies you already downloaded)" 2
sha() { python3 -c 'import hashlib,sys
h = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
print(h.hexdigest())' "$1"; }
size() { python3 -c 'import os,sys; print(os.path.getsize(sys.argv[1]))' "$1"; }
NAME_RE='^dazl-(backup-[0-9A-Za-z._-]+\.db|ledger-[0-9]{8}T[0-9]{6}Z\.jsonl)\.age(\.json)?$'

( umask 077; mkdir -- "$OUT" ); chmod 700 "$OUT"
db=; ok=0; trap '[ "$ok" = 1 ] || { [ -z "$db" ] || rm -f -- "$db"; }' EXIT
step() { echo "$1  $2"; }

# ---- 1. find and fetch
if [ -n "$FROM" ]; then
  # newest = the newest name: dazl-backup-<UTC time>-... sorts by time
  name=$(cd "$FROM" && ls | grep -E '^dazl-backup-[0-9A-Za-z._-]+\.db\.age$' | LC_ALL=C sort | tail -1 || true)
  ledger=$(cd "$FROM" && ls | grep -E '^dazl-ledger-[0-9]{8}T[0-9]{6}Z\.jsonl\.age$' | LC_ALL=C sort | tail -1 || true)
  [ -n "$name" ] || { step FAIL "find: no dazl-backup-*.db.age in $FROM"; exit 1; }
  for f in "$name" "$name.json" ${ledger:+"$ledger"}; do [ -f "$FROM/$f" ] || { step FAIL "find: $f is missing in $FROM"; exit 1; }; cp -- "$FROM/$f" "$OUT/$f"; done
  modified=
else
  listing=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/dazl-" --region "$REGION" --output json) || { step FAIL "find: could not list s3://$BUCKET/$PREFIX/ (are you signed in to the dazl AWS account?)"; exit 1; }
  picked=$(printf '%s' "$listing" | PREFIX=$PREFIX python3 -c '
import json, os, re, sys
raw = sys.stdin.read().strip(); d = (json.loads(raw) if raw else {}) or {}
pre = os.environ["PREFIX"] + "/"
objs = [(o["LastModified"], o["Key"][len(pre):]) for o in d.get("Contents") or [] if o["Key"].startswith(pre)]
def newest(rx):
    hits = sorted((m, n) for m, n in objs if re.match(rx, n))
    return hits[-1] if hits else ("", "")
b = newest(r"^dazl-backup-[0-9A-Za-z._-]+\.db\.age$"); l = newest(r"^dazl-ledger-[0-9]{8}T[0-9]{6}Z\.jsonl\.age$")
print(b[1] or "-", b[0] or "-", l[1] or "-")')
  read -r name modified ledger <<<"$picked"
  [ "$name" != - ] || { step FAIL "find: no dazl-backup-*.db.age under s3://$BUCKET/$PREFIX/"; exit 1; }
  [ "$ledger" != - ] || ledger=
  for f in "$name" "$name.json" ${ledger:+"$ledger"}; do
    [[ $f =~ $NAME_RE ]] || { step FAIL "find: unexpected object name"; exit 1; }
    aws s3api get-object --bucket "$BUCKET" --key "$PREFIX/$f" --region "$REGION" "$OUT/$f" >/dev/null || { step FAIL "find: could not download $f"; exit 1; }
  done
fi
step PASS "find: newest copy is $name${modified:+ (uploaded $modified)}"

# ---- 2. the ciphertext is the one its manifest describes
read -r want_ct want_bytes want_src created < <(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    assert d.get("tool") == "dazl-offhost-copy" and d.get("ciphertext") == sys.argv[2]
    print(d["ciphertext_sha256"], d["bytes"], d["source_sha256"], d.get("source_created_at") or "-")
except Exception: print("- - - -")' "$OUT/$name.json" "$name")
[ "$want_ct" != - ] || { step FAIL "check: $name.json is not the manifest of $name"; exit 1; }
[ "$(size "$OUT/$name")" = "$want_bytes" ] && [ "$(sha "$OUT/$name")" = "$want_ct" ] || { step FAIL "check: the downloaded copy does not have the size and sha256 its manifest declares"; exit 1; }
step PASS "check: $want_bytes bytes, sha256 matches the manifest"

# ---- 3. decrypt
db=$OUT/${name%.age}
( umask 077; age -d -i "$ID" -o "$db" -- "$OUT/$name" ) || { step FAIL "decrypt: age could not decrypt the copy with this identity (is it the key pair aws-setup.sh made?)"; exit 1; }
chmod 600 "$db"
[ "$(sha "$db")" = "$want_src" ] || { step FAIL "decrypt: the decrypted file is not the snapshot the box took (sha256 differs from the manifest)"; exit 1; }
step PASS "decrypt: byte for byte the snapshot the box took"
if [ -n "$ledger" ]; then
  if ( umask 077; age -d -i "$ID" -o "$OUT/${ledger%.age}" -- "$OUT/$ledger" ); then step PASS "ledger: the deletion ledger copy decrypts ($(grep -c . "$OUT/${ledger%.age}" || true) line(s)); docs/RECOVERY.md step 6 re-applies it"
  else step FAIL "ledger: the deletion ledger copy did not decrypt"; exit 1; fi
fi

# ---- 4. the database opens and is whole
verdict=$(python3 -c '
import sqlite3, sys
c = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
res = [r[0] for r in c.execute("PRAGMA integrity_check")]
if res != ["ok"]: print("FAIL integrity_check: " + "; ".join(res[:3])); sys.exit(0)
counts = []
for t in ("users", "scan_jobs", "leads"):
    try: counts.append(t + " " + str(c.execute("select count(*) from " + t).fetchone()[0]))
    except sqlite3.Error: counts.append(t + " (no such table)")
print("PASS " + ", ".join(counts))' "$db" 2>/dev/null) || verdict="FAIL the file is not a readable SQLite database"
[ "${verdict%% *}" = PASS ] || { step FAIL "verify: ${verdict#FAIL }"; exit 1; }
step PASS "verify: PRAGMA integrity_check ok; rows: ${verdict#PASS }"
ok=1
age_note=
if [ "$created" != - ]; then age_note=$(python3 -c 'import sys,datetime
s = int((datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))).total_seconds())
print("backup taken " + sys.argv[1] + ": " + str(s // 60) + " minutes ago (what losing the box right now would lose)")' "$created" 2>/dev/null || true); fi
echo
echo "restore-s3: ALL PASS. The restored database is $db"
[ -z "$age_note" ] || echo "restore-s3: $age_note"
echo "restore-s3: it is a full copy of production. After a drill, delete it:  rm -rf $OUT"
