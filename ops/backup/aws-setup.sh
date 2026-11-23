#!/usr/bin/env bash
# Step 1 of 2 of the off-host production backup (issue #1080; ops/backup/README.md). Run by the OWNER on her own
# machine, with her own AWS CLI login to the existing dazl AWS account. Never on the production box.
#
#   bash ops/backup/aws-setup.sh --dry-run            # prints every AWS call and every JSON document, makes none
#   bash ops/backup/aws-setup.sh                      # bucket dazl-prod-backups-<account id>, asks before it starts
#   bash ops/backup/aws-setup.sh my-bucket-name --yes # another bucket name, no question
#
# What it makes (each step is skipped when it is already exactly so; run it again any time):
#   1. the age key pair for the backups, in --out (default ~/dazl-backup-keys, mode 700): dazl-offhost-identity.txt is
#      the PRIVATE key (mode 600) and never leaves this machine except to the offline places the README names
#   2. the S3 bucket in --region (default ca-central-1): Block Public Access all on, default encryption (SSE-S3),
#      versioning on, one lifecycle rule: objects expire after 30 days, old versions are deleted after 30 days
#   3. the IAM user --user (default dazl-backup-writer) with ONE inline policy: s3:PutObject on <bucket>/<prefix>/* and
#      s3:ListBucket on that prefix. No read, no delete, nothing else in the account
#   4. one access key for that user, written to <out>/<bucket>.s3.env (mode 600) together with the bucket, region,
#      prefix and the age PUBLIC key: the one file install-prod-offhost.sh needs on the box
# What it refuses (exit 1, nothing changed):
#   - a bucket that already exists with other settings than the ones above (it names each difference). Only with
#     --configure-empty-bucket, and only when the bucket holds no object at all, are the settings applied to it
#   - a bucket of that name in someone else's account; an IAM user of that name that has any other permission
#   - a user that already has an access key this machine has no file for (--new-key makes a second one; IAM allows two)
# Secrets: the secret access key goes from the AWS CLI straight into the mode-600 file. It is never an argument, never
# in a variable that is printed, never on the terminal. The access key ID (not a secret) is printed.
# Options: [BUCKET] --region R --prefix P --user U --out DIR --yes --dry-run --configure-empty-bucket --new-key
# Exit: 0 done (or already done); 1 refused or an AWS call failed (named); 2 usage.
set -euo pipefail
die() { echo "aws-setup: $1" >&2; exit "${2:-1}"; }
say() { echo "aws-setup: $1"; }
BUCKET=; REGION=ca-central-1; PREFIX=prod; IAM_USER=dazl-backup-writer; OUT=${HOME:?}/dazl-backup-keys
YES=0; DRY=0; ADOPT_EMPTY=0; NEW_KEY=0
POLICY_NAME=dazl-backup-put-only; EXPIRE_DAYS=30
while [ $# -gt 0 ]; do
  case "$1" in
    --region|--prefix|--user|--out) [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" 2
      case "$1" in --region) REGION=$2 ;; --prefix) PREFIX=$2 ;; --user) IAM_USER=$2 ;; --out) OUT=$2 ;; esac; shift 2 ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --configure-empty-bucket) ADOPT_EMPTY=1; shift ;;
    --new-key) NEW_KEY=1; shift ;;
    -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1 (see --help)" 2 ;;
    *) [ -z "$BUCKET" ] || die "one bucket name only (got '$BUCKET' and '$1')" 2; BUCKET=$1; shift ;;
  esac
done
[[ $REGION =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "--region '$REGION' is not a region name" 2
[[ $PREFIX =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "--prefix must be one plain name (letters, digits, . _ -)" 2
[[ $IAM_USER =~ ^[A-Za-z0-9+=,.@_-]{1,64}$ ]] || die "--user '$IAM_USER' is not an IAM user name" 2
[[ $OUT == /* ]] || die "--out must be an absolute path" 2
# no dots: the bucket name is a TLS host name for the box's uploads
check_bucket_name() { [[ $1 =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || die "bucket name '$1' must be 3-63 lowercase letters, digits and hyphens (no dots)" 2; }
[ -z "$BUCKET" ] || check_bucket_name "$BUCKET"
command -v python3 >/dev/null || die "python3 is needed (it compares the bucket's settings and writes the key file)" 2

# ---- the documents, as files (never built on a command line)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; chmod 700 "$tmp"
write_docs() {   # $1 = bucket
  cat > "$tmp/public-access-block.json" <<'JSON'
{"BlockPublicAcls": true, "IgnorePublicAcls": true, "BlockPublicPolicy": true, "RestrictPublicBuckets": true}
JSON
  cat > "$tmp/encryption.json" <<'JSON'
{"Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}
JSON
  cat > "$tmp/lifecycle.json" <<JSON
{"Rules": [{"ID": "dazl-backups-expire-after-${EXPIRE_DAYS}-days", "Status": "Enabled", "Filter": {"Prefix": ""},
  "Expiration": {"Days": ${EXPIRE_DAYS}}, "NoncurrentVersionExpiration": {"NoncurrentDays": ${EXPIRE_DAYS}},
  "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}}]}
JSON
  cat > "$tmp/policy.json" <<JSON
{"Version": "2012-10-17", "Statement": [
  {"Sid": "PutBackupCopiesOnly", "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::$1/${PREFIX}/*"},
  {"Sid": "ListBackupCopiesOnly", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::$1",
   "Condition": {"StringLike": {"s3:prefix": ["${PREFIX}/*"]}}}]}
JSON
  for f in public-access-block encryption lifecycle policy; do python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp/$f.json" || die "internal: $f.json is not valid JSON"; done
}
ID_FILE=$OUT/dazl-offhost-identity.txt
print_cmd() { printf '  aws'; local a; for a in "$@"; do case "$a" in file://*) printf ' file://%s' "$(basename "$a")" ;; *) printf ' %q' "$a" ;; esac; done; printf '\n'; }

# ---- dry run: the whole plan for an account where nothing exists yet; not one AWS call
if [ "$DRY" = 1 ]; then
  B=${BUCKET:-dazl-prod-backups-ACCOUNT_ID}
  write_docs "$B"
  say "DRY RUN: nothing is called, created or written. These are the calls a first run makes, in order."
  say "(the bucket name defaults to dazl-prod-backups-<your 12-digit account id>; ACCOUNT_ID stands for it below)"
  echo "1. the age key pair (local, no AWS):"
  echo "  age-keygen -o $ID_FILE     # only when that file does not exist yet"
  echo "2. who am I, and does the bucket exist:"
  print_cmd sts get-caller-identity --output json
  print_cmd s3api head-bucket --bucket "$B"
  echo "3. the bucket and its four settings:"
  print_cmd s3api create-bucket --bucket "$B" --region "$REGION" --create-bucket-configuration "LocationConstraint=$REGION"
  print_cmd s3api put-public-access-block --bucket "$B" --public-access-block-configuration "file://$tmp/public-access-block.json"
  print_cmd s3api put-bucket-encryption --bucket "$B" --server-side-encryption-configuration "file://$tmp/encryption.json"
  print_cmd s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Enabled
  print_cmd s3api put-bucket-lifecycle-configuration --bucket "$B" --lifecycle-configuration "file://$tmp/lifecycle.json"
  echo "4. read every setting back and compare (a difference stops the script):"
  for c in get-bucket-location get-public-access-block get-bucket-encryption get-bucket-versioning get-bucket-lifecycle-configuration; do print_cmd s3api "$c" --bucket "$B" --output json; done
  echo "5. the upload-only IAM user:"
  print_cmd iam get-user --user-name "$IAM_USER"
  print_cmd iam create-user --user-name "$IAM_USER" --tags Key=purpose,Value=dazl-offhost-backup
  print_cmd iam put-user-policy --user-name "$IAM_USER" --policy-name "$POLICY_NAME" --policy-document "file://$tmp/policy.json"
  print_cmd iam list-user-policies --user-name "$IAM_USER" --output json
  print_cmd iam list-attached-user-policies --user-name "$IAM_USER" --output json
  print_cmd iam list-groups-for-user --user-name "$IAM_USER" --output json
  echo "6. one access key (its secret goes straight into $OUT/$B.s3.env, mode 600; never to the terminal):"
  print_cmd iam list-access-keys --user-name "$IAM_USER" --output json
  print_cmd iam create-access-key --user-name "$IAM_USER" --output json
  for f in public-access-block encryption lifecycle policy; do echo "--- $f.json"; cat "$tmp/$f.json"; done
  exit 0
fi

command -v aws >/dev/null || die "the AWS CLI is not installed (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), or use --dry-run" 2
command -v age-keygen >/dev/null || die "age is not installed (macOS: brew install age). It makes the key pair the backups are encrypted to" 2
# an AWS call whose failure stops the script, naming the call (the CLI's own message is shown; it holds no secret)
aws_() { aws "$@" || die "this AWS call failed: aws $1 $2 (see the message above). Nothing after it was run."; }
# a read that may legitimately find nothing: prints the JSON, or {} when the error is one of the "not there" codes in $1
aws_maybe() { local missing=$1 out; shift
  if out=$(aws "$@" 2>"$tmp/err"); then printf '%s' "$out"
  elif grep -Eq "$missing" "$tmp/err"; then printf '{}'
  else cat "$tmp/err" >&2; die "this AWS call failed: aws $1 $2"; fi; }

# py EXPR [ARGS]: evaluates EXPR with d = the JSON on stdin ({} when empty) and a = ARGS; prints the result
py() { python3 -c 'import json,sys
raw = sys.stdin.read().strip(); d = (json.loads(raw) if raw else {}) or {}; a = sys.argv[2:]
print(eval(sys.argv[1]))' "$@"; }

# ---- who and where
ident=$(aws_ sts get-caller-identity --output json)
ACCT=$(printf '%s' "$ident" | py 'd["Account"]')
ARN=$(printf '%s' "$ident" | py 'd["Arn"]')
[[ $ACCT =~ ^[0-9]{12}$ ]] || die "could not read the account id from sts get-caller-identity"
BUCKET=${BUCKET:-dazl-prod-backups-$ACCT}; check_bucket_name "$BUCKET"
write_docs "$BUCKET"
CRED_FILE=$OUT/$BUCKET.s3.env
say "AWS account $ACCT, signed in as $ARN"
say "bucket $BUCKET in $REGION, upload-only user $IAM_USER, key files in $OUT"
if [ "$YES" != 1 ]; then
  [ -t 0 ] || die "not a terminal: pass --yes to go ahead without the question" 2
  read -r -p "aws-setup: is this the dazl AWS account, and shall I go ahead? [y/N] " answer
  [[ $answer == [yY] || $answer == [yY][eE][sS] ]] || die "stopped: nothing was changed"
fi

# ---- 1. the age key pair (before any AWS change, so a missing tool never leaves AWS half set up)
( umask 077; mkdir -p "$OUT" ); chmod 700 "$OUT"
if [ -f "$ID_FILE" ]; then say "1. age key pair: $ID_FILE already exists: kept"
else ( umask 077; age-keygen -o "$ID_FILE" 2>/dev/null ); chmod 600 "$ID_FILE"; say "1. age key pair: made $ID_FILE (PRIVATE key, mode 600)"; fi
RECIPIENT=$(age-keygen -y "$ID_FILE")
[[ $RECIPIENT =~ ^age1[0-9a-z]+$ ]] || die "$ID_FILE is not an age identity"

# ---- 2. the bucket
# settings as they are, compared with the documents above; prints one line per difference
differences() {
  local loc pab encr ver life
  # each read must succeed: a setting that could not be read is never taken for "not set" (errexit is off in here)
  loc=$(aws_ s3api get-bucket-location --bucket "$BUCKET" --output json) || return 1
  pab=$(aws_maybe NoSuchPublicAccessBlockConfiguration s3api get-public-access-block --bucket "$BUCKET" --output json) || return 1
  encr=$(aws_maybe ServerSideEncryptionConfigurationNotFound s3api get-bucket-encryption --bucket "$BUCKET" --output json) || return 1
  ver=$(aws_ s3api get-bucket-versioning --bucket "$BUCKET" --output json) || return 1
  life=$(aws_maybe NoSuchLifecycleConfiguration s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" --output json) || return 1
  REGION=$REGION DAYS=$EXPIRE_DAYS LOC=$loc PAB=$pab ENCR=$encr VER=$ver LIFE=$life python3 - <<'PY'
import json, os
def j(name):
    try: return json.loads(os.environ[name] or '{}') or {}
    except Exception: return {}
region, days = os.environ['REGION'], int(os.environ['DAYS'])
out = []
loc = j('LOC').get('LocationConstraint') or 'us-east-1'
if loc != region: out.append(f'region is {loc}, wanted {region}')
pab = j('PAB').get('PublicAccessBlockConfiguration') or {}
off = [k for k in ('BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets') if pab.get(k) is not True]
if off: out.append('Block Public Access is not fully on (' + ', '.join(off) + ')')
rules = (j('ENCR').get('ServerSideEncryptionConfiguration') or {}).get('Rules') or []
algo = [(r.get('ApplyServerSideEncryptionByDefault') or {}).get('SSEAlgorithm') for r in rules]
if algo != ['AES256']: out.append(f'default encryption is {algo or "not set"}, wanted SSE-S3 (AES256)')
v = j('VER')
if v.get('Status') != 'Enabled': out.append(f'versioning is {v.get("Status") or "off"}, wanted Enabled')
lr = j('LIFE').get('Rules') or []
def whole(r):
    f = r.get('Filter')
    return (f in (None, {}) or f == {'Prefix': ''}) and (r.get('Prefix') or '') == ''
ok = (len(lr) == 1 and lr[0].get('Status') == 'Enabled' and whole(lr[0])
      and (lr[0].get('Expiration') or {}).get('Days') == days
      and (lr[0].get('NoncurrentVersionExpiration') or {}).get('NoncurrentDays') == days
      and not lr[0].get('Transitions') and not lr[0].get('NoncurrentVersionTransitions'))
if not ok: out.append(f'the lifecycle is not the single rule "expire objects and old versions after {days} days" ({len(lr)} rule(s) found)')
print('\n'.join(out))
PY
}
apply_settings() {
  aws_ s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration "file://$tmp/public-access-block.json"
  aws_ s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration "file://$tmp/encryption.json"
  aws_ s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
  aws_ s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration "file://$tmp/lifecycle.json"
}
# head-bucket with the account as expected owner: 0 = ours; "404" = no such bucket; anything else = not ours or no access
if aws s3api head-bucket --bucket "$BUCKET" --expected-bucket-owner "$ACCT" >/dev/null 2>"$tmp/err"; then
  diffs=$(differences) || die "the settings of bucket $BUCKET could not be read (see above): nothing more was done"
  if [ -z "$diffs" ]; then say "2. bucket $BUCKET: already exists with exactly these settings: nothing changed"
  elif [ "$ADOPT_EMPTY" = 1 ]; then
    versions=$(aws_ s3api list-object-versions --bucket "$BUCKET" --max-items 1 --output json)
    held=$(printf '%s' "$versions" | py 'len(d.get("Versions") or []) + len(d.get("DeleteMarkers") or [])')
    [ "$held" = 0 ] \
      || die "bucket $BUCKET exists with other settings AND holds objects: refusing to change it, even with --configure-empty-bucket. Differences:"$'\n'"$diffs"
    where=$(aws_ s3api get-bucket-location --bucket "$BUCKET" --output json); where=$(printf '%s' "$where" | py 'd.get("LocationConstraint") or "us-east-1"')
    [ "$where" = "$REGION" ] \
      || die "bucket $BUCKET is in another region than $REGION: a bucket cannot be moved. Give another name."
    apply_settings
    diffs=$(differences) || die "the settings of bucket $BUCKET could not be read (see above): nothing more was done"; [ -z "$diffs" ] || die "bucket $BUCKET still differs after applying the settings:"$'\n'"$diffs"
    say "2. bucket $BUCKET: existed and was EMPTY: the four settings were applied (--configure-empty-bucket) and read back"
  else
    die "bucket $BUCKET already exists with other settings; nothing was changed. Differences:"$'\n'"$diffs"$'\n'"Give another bucket name, or, if this is the empty bucket of an interrupted earlier run, run again with --configure-empty-bucket."
  fi
elif grep -Eq '\(404\)|Not Found|NoSuchBucket' "$tmp/err"; then
  if [ "$REGION" = us-east-1 ]; then aws_ s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else aws_ s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null; fi
  apply_settings
  diffs=$(differences) || die "the settings of bucket $BUCKET could not be read (see above): nothing more was done"; [ -z "$diffs" ] || die "bucket $BUCKET was created but its settings did not read back as set:"$'\n'"$diffs"
  say "2. bucket $BUCKET: created in $REGION; public access blocked, encryption on, versioning on, ${EXPIRE_DAYS}-day lifecycle; all read back"
else
  cat "$tmp/err" >&2
  die "bucket $BUCKET exists but is not in this account, or this login may not see it: nothing was changed. Give another bucket name."
fi

# ---- 3. the upload-only user
if aws iam get-user --user-name "$IAM_USER" >/dev/null 2>"$tmp/err"; then
  inline=$(aws_ iam list-user-policies --user-name "$IAM_USER" --output json)
  attached=$(aws_ iam list-attached-user-policies --user-name "$IAM_USER" --output json)
  groups=$(aws_ iam list-groups-for-user --user-name "$IAM_USER" --output json)
  extra=$(printf '%s' "$inline" | py '" ".join("inline:" + p for p in d.get("PolicyNames") or [] if p != a[0])' "$POLICY_NAME")
  extra="$extra $(printf '%s' "$attached" | py '" ".join("attached:" + p.get("PolicyName", "?") for p in d.get("AttachedPolicies") or [])')"
  extra="$extra $(printf '%s' "$groups" | py '" ".join("group:" + g.get("GroupName", "?") for g in d.get("Groups") or [])')"
  extra=$(printf '%s' "$extra" | tr -s ' ' | sed -e 's/^ //' -e 's/ $//')
  [ -z "$extra" ] || die "IAM user $IAM_USER already exists and has other permissions ($extra): refusing to use it as the upload-only user. Give another --user."
  user_note="already existed with no other permission"
elif grep -q NoSuchEntity "$tmp/err"; then
  aws_ iam create-user --user-name "$IAM_USER" --tags Key=purpose,Value=dazl-offhost-backup >/dev/null
  user_note="created"
else cat "$tmp/err" >&2; die "this AWS call failed: aws iam get-user"; fi
aws_ iam put-user-policy --user-name "$IAM_USER" --policy-name "$POLICY_NAME" --policy-document "file://$tmp/policy.json"
say "3. IAM user $IAM_USER: $user_note; its one policy ($POLICY_NAME) allows s3:PutObject on $BUCKET/$PREFIX/* and s3:ListBucket on that prefix, nothing else"

# ---- 4. one access key, its secret straight into the mode-600 file
keys=$(aws_ iam list-access-keys --user-name "$IAM_USER" --output json); keys=$(printf '%s' "$keys" | py '" ".join(k["AccessKeyId"] for k in d.get("AccessKeyMetadata") or [])')
have=; [ ! -f "$CRED_FILE" ] || have=$(sed -n 's/^AWS_ACCESS_KEY_ID=//p' "$CRED_FILE" | head -1)
write_cred_file() {   # stdin: the create-access-key JSON, or nothing to keep the key the file already has
  ( umask 077; CRED_FILE=$CRED_FILE REGION=$REGION BUCKET=$BUCKET PREFIX=$PREFIX RECIPIENT=$RECIPIENT python3 -c '
import json, os, sys
e = os.environ; f = e["CRED_FILE"]; raw = sys.stdin.read().strip()
if raw:
    k = json.loads(raw)["AccessKey"]; kid, secret = k["AccessKeyId"], k["SecretAccessKey"]
else:
    old = dict(l.strip().split("=", 1) for l in open(f) if "=" in l and not l.startswith("#"))
    kid, secret = old["AWS_ACCESS_KEY_ID"], old["AWS_SECRET_ACCESS_KEY"]
lines = ["# SECRET. The upload-only key of the dazl production backup (issue #1080), written by ops/backup/aws-setup.sh.",
         "# Copy this file to the production box for ops/backup/install-prod-offhost.sh, then keep it here or delete it.",
         "AWS_ACCESS_KEY_ID=" + kid, "AWS_SECRET_ACCESS_KEY=" + secret, "AWS_REGION=" + e["REGION"],
         "DAZL_BACKUP_BUCKET=" + e["BUCKET"], "DAZL_BACKUP_PREFIX=" + e["PREFIX"], "DAZL_BACKUP_AGE_RECIPIENT=" + e["RECIPIENT"]]
fd = os.open(f + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as h: h.write("\n".join(lines) + "\n")
os.chmod(f + ".tmp", 0o600); os.replace(f + ".tmp", f)
print(kid)
' ); }
if [ -n "$have" ] && [[ " $keys " == *" $have "* ]] && [ "$NEW_KEY" != 1 ]; then
  KEY_ID=$(write_cred_file </dev/null)   # same key; bucket, region and public key lines refreshed
  say "4. access key $KEY_ID: already made and already in $CRED_FILE: no new key"
else
  n=$(printf '%s' "$keys" | wc -w | tr -d ' ')
  if [ "$n" -gt 0 ] && [ "$NEW_KEY" != 1 ]; then
    die "IAM user $IAM_USER already has an access key ($keys) but $CRED_FILE does not hold it, and a secret can only be read when the key is made. Either copy that file back here, or run again with --new-key (and afterwards delete the old key: aws iam delete-access-key --user-name $IAM_USER --access-key-id <old id>)."
  fi
  [ "$n" -lt 2 ] || die "IAM user $IAM_USER already has two access keys ($keys), the most IAM allows: delete one first (aws iam delete-access-key --user-name $IAM_USER --access-key-id <id>)."
  KEY_ID=$(aws_ iam create-access-key --user-name "$IAM_USER" --output json | write_cred_file)
  [[ $KEY_ID =~ ^[A-Z0-9]{16,}$ ]] || die "the new access key could not be written to $CRED_FILE"
  say "4. access key $KEY_ID: made; its secret is in $CRED_FILE (mode 600) and was not shown"
fi
chmod 600 "$CRED_FILE"

cat <<EOF

aws-setup: DONE. On the production box, /etc/dazl-backup/s3.env will hold exactly these lines
(install-prod-offhost.sh writes them from the file below; you do not type them):
  AWS_ACCESS_KEY_ID=$KEY_ID
  AWS_SECRET_ACCESS_KEY=<the secret, only in $CRED_FILE>
  AWS_REGION=$REGION
and /etc/dazl-backup/env will get: OFFHOST_DEST=s3:$BUCKET/$PREFIX
The backups are encrypted to this PUBLIC key (safe to show): $RECIPIENT

Next (step 2 of 2), once this change is deployed to production (ops/backup/README.md has the same lines):
  scp $CRED_FILE ubuntu@<the box>:/home/ubuntu/dazl-backup.s3.env
  ssh ubuntu@<the box>
  REL=\$(for d in \$(sed -n 's/^DAZL_RELEASE=//p' /etc/dazl-prod/ports/*.conf); do [ -f "\$d/ops/backup/install-prod-offhost.sh" ] && echo "\$d"; done | head -1)
  sudo bash "\$REL/ops/backup/install-prod-offhost.sh" --credentials /home/ubuntu/dazl-backup.s3.env

Keep OFF the box and OUT of the bucket (ops/backup/README.md says where):
  $ID_FILE   the PRIVATE key: without it no backup can ever be read
EOF
