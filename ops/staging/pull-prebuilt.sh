#!/usr/bin/env bash
# Staging auto-deploy from a prebuilt build (docs/STAGING.md, "Automatic deploys from prebuilt builds").
# The staging box (1.8 GB RAM, 2 CPUs) cannot run `next build`, so the build happens on a free GitHub-hosted runner
# (.github/workflows/staging-prebuilt.yml, on every push to main) and is published as assets of the `staging-prebuilt`
# prerelease of this public repo. Run by dazl-staging-prebuilt.timer every 2 minutes, as root, this script:
#   1. reads main's head commit (git ls-remote, no token: the repo is public);
#   0. refuses to run unless the installed deploy.sh is trusted (root-owned, root-writable only, no symlink, in
#      root-owned directories; the #908 layout) and `deploy.sh --check-env` accepts the env file;
#   2. does nothing when that commit is already live (deploy.sh's $STAGING_STATE_ROOT/current-sha) or failed less than
#      STAGING_RETRY_AFTER_S ago (any failure after the manifest is accepted), or when no prebuilt build is published yet;
#   3. reads the build's manifest (staging-prebuilt-<sha>.json, uploaded last, so a manifest means a complete set) and
#      checks it names exactly that commit, this box's CPU architecture and Node ABI;
#   4. skips (journal ALERT) when the downloads plus a database backup would take free space below the 2 GiB floor
#      plus a reserve, before downloading anything;
#   5. downloads the build (and node_modules only when the lockfile differs from the live release's) within one time
#      budget, checks each file's size and sha256 against the manifest and the commit inside the build (.build-commit);
#   6. backs up the staging SQLite database (never through a symlink or a second hard link; online backup API,
#      integrity_check ok) into a root-only directory, keeping the newest STAGING_KEEP_BACKUPS (>= 1); no verified backup,
#      no deploy;
#   7. runs the installed deploy.sh with STAGING_BUILD replaced by `pull-prebuilt.sh --extract`: deploy.sh keeps doing
#      everything else (disk floor, release dir, its own migrate + seed step, health check, rollback, and keeping the
#      live release plus two rollbacks). The extract step runs as the service user in the new release's web/ and only
#      unpacks the verified build whose commit equals the one deploy.sh is deploying; if main moved in between, it
#      fails closed and deploy.sh removes the release (the live one is untouched). Nothing is built on the box.
# No secret is needed or stored: the assets are public downloads over https.
# Usage: pull-prebuilt.sh             deploy main's prebuilt build if main changed
#        pull-prebuilt.sh --dry-run   every read-only check, then print what it would do (downloads, backs up, deploys nothing)
#        pull-prebuilt.sh --extract DIR   (deploy.sh's build step, in the release's web/ directory) unpack the verified build
set -euo pipefail

REPO=${STAGING_PREBUILT_REPO:-gagan114662/dazl}
REPO_URL=${STAGING_REPO_URL:-https://github.com/$REPO.git}
TAG=${STAGING_PREBUILT_TAG:-staging-prebuilt}
BASE_URL=${STAGING_PREBUILT_BASE_URL:-https://github.com/$REPO/releases/download/$TAG}
ROOT=${STAGING_ROOT:-/srv/dazl-staging}
ENV_FILE=${STAGING_ENV_FILE:-/etc/dazl-staging/env}
# The installed deploy script. Prerequisite: the #908 layout (docs/STAGING.md "Upgrading to the root-owned deploy"): a
# root-owned deploy.sh outside the service account's home. Root runs it, so it is refused unless it and every directory
# above it are root-owned and writable by root only (finding 1, #1061 review: a script the service account can replace
# would run as root every 2 minutes).
DEPLOY=${STAGING_DEPLOY_SH:-/usr/local/lib/dazl-staging/deploy.sh}
# Who the deploy script must belong to. Tests stand in a test user for root; the unit never sets this.
TRUSTED_UID=${STAGING_TRUSTED_UID:-0}
# Downloads: root-owned, world-readable (the extract step runs as the service user), never writable by it.
DL=${STAGING_PREBUILT_DIR:-/var/cache/dazl-staging-prebuilt}
# This script's own state (lock, failure stamps): root-only.
PSTATE=${STAGING_PREBUILT_STATE:-/var/lib/dazl-staging-prebuilt}
BACKUPS=${STAGING_BACKUP_DIR:-/var/lib/dazl-staging-backups}
KEEP_BACKUPS=${STAGING_KEEP_BACKUPS-3}
# Where deploy.sh records the live commit: its own root-owned state directory (the same variable deploy.sh reads, so the
# two can never disagree: finding 2). The pre-#908 $ROOT/current-sha, inside the service account's home, is never read.
STATE_ROOT=${STAGING_STATE_ROOT:-/var/lib/dazl-staging-deploy}
CURRENT_FILE=$STATE_ROOT/current-sha
MIN_FREE_BYTES=${MIN_FREE_BYTES:-2147483648}
DISK_RESERVE_BYTES=${DISK_RESERVE_BYTES:-268435456}
RETRY_AFTER_S=${STAGING_RETRY_AFTER_S:-1800}
MAX_ASSET_BYTES=${STAGING_MAX_ASSET_BYTES:-2000000000}
# One time budget for all downloads of a run (finding 7). With the time deploy.sh may take (DEPLOY_ALLOWANCE_S: release,
# migrate, health check, rollback) it stays below the unit's TimeoutStartSec, so systemd never kills a valid run; the
# test checks the three numbers against each other.
DOWNLOAD_BUDGET_S=${STAGING_DOWNLOAD_BUDGET_S:-2400}
# Enforced (#1061 review): deploy.sh runs under `timeout`, so it is stopped inside its allowance (and reported), never by
# systemd's TimeoutStartSec mid-step with no word on why.
DEPLOY_ALLOWANCE_S=${STAGING_DEPLOY_ALLOWANCE_S:-1800}

log() { echo "staging-prebuilt: $*"; }
# After the manifest is accepted, every fatal failure writes the retry stamp (finding 4), so a bad asset or a failing
# backup is not retried every tick; a build not published yet and low disk are not failures and write none.
stamp=
fail() { echo "staging-prebuilt: $*" >&2; [ -z "$stamp" ] || touch "$stamp" 2>/dev/null || true; exit 1; }
is_sha() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]]; }
sha256() { sha256sum -- "$1" | cut -c1-64; }
val() { sed -n "s/^\(export \)\{0,1\}$1=//p" "$2" | tail -n 1 | sed "s/^[\"']//; s/[\"']$//"; }

# --extract DIR: deploy.sh's build step, run as the service user in the new release's web/ directory, where deploy.sh has
# just written the commit it is deploying to .build-commit. Unpacks only a build root verified and recorded for exactly
# that commit; otherwise fails, and deploy.sh removes the release.
extract() {
  local dir=$1 want got next mods
  want=$(cat .build-commit 2>/dev/null || true)
  is_sha "$want" || fail "extract: .build-commit does not name a commit; nothing extracted"
  next="staging-next-$want.tgz"; mods="staging-modules-$want.tgz"
  [ -f "$dir/$next" ] && [ -f "$dir/$next.sha256" ] || fail "extract: no verified prebuilt build of $want in $dir (main moved after the check?); nothing extracted"
  (cd "$dir" && sha256sum --quiet -c -- "$next.sha256") || fail "extract: $next does not match its recorded sha256; nothing extracted"
  got=$(tar -xzOf "$dir/$next" .build-commit 2>/dev/null || true)
  [ "$got" = "$want" ] || fail "extract: $next was built from ${got:-an unknown commit}, not $want; nothing extracted"
  rm -rf .next
  tar -xzf "$dir/$next" --no-same-owner --no-same-permissions .next .build-commit
  [ "$(cat .build-commit)" = "$want" ] && [ -f .next/BUILD_ID ] || fail "extract: the unpacked build is incomplete"
  if [ ! -d node_modules ]; then
    # the lockfile changed (deploy.sh only hard-links node_modules when it did not): the runner's node_modules is needed
    [ -f "$dir/$mods" ] && [ -f "$dir/$mods.sha256" ] || fail "extract: no node_modules here and no verified $mods; nothing installed on the box"
    (cd "$dir" && sha256sum --quiet -c -- "$mods.sha256") || fail "extract: $mods does not match its recorded sha256"
    tar -xzf "$dir/$mods" --no-same-owner --no-same-permissions node_modules
  fi
  [ -f node_modules/next/package.json ] || fail "extract: node_modules has no next"
  log "extracted the prebuilt build of $want"
}

if [ "${1:-}" = --extract ]; then extract "${2:?usage: pull-prebuilt.sh --extract DIR}"; exit 0; fi
dry=0
case "${1:-}" in
  --dry-run) dry=1 ;;
  '') ;;
  *) fail "usage: pull-prebuilt.sh [--dry-run]" ;;
esac

# finding 3: a whole number >= 1, or the just-verified backup would be deleted before deploy.sh runs
[[ $KEEP_BACKUPS =~ ^[1-9][0-9]{0,3}$ ]] || fail "STAGING_KEEP_BACKUPS must be a whole number of at least 1 (got '$KEEP_BACKUPS'); nothing done"
[[ $DOWNLOAD_BUDGET_S =~ ^[0-9]+$ ]] || fail "STAGING_DOWNLOAD_BUDGET_S must be a whole number of seconds; nothing done"
[[ $DEPLOY_ALLOWANCE_S =~ ^[1-9][0-9]*$ ]] || fail "STAGING_DEPLOY_ALLOWANCE_S must be a whole number of seconds >= 1; nothing done"
BACKUP_ALLOWANCE_S=${STAGING_BACKUP_ALLOWANCE_S:-300}
[[ $BACKUP_ALLOWANCE_S =~ ^[1-9][0-9]*$ ]] || fail "STAGING_BACKUP_ALLOWANCE_S must be a whole number of seconds >= 1; nothing done"
# Every step is bounded, and together they end before the unit's TimeoutStartSec (80 min = 4800 s) with a minute to spare:
# reading main (60 s + 5 s kill grace), the manifest (60 s), the downloads, the database backup and its 10 s kill grace, deploy.sh and its
# 60 s kill grace.
UNIT_LIMIT_S=4740   # TimeoutStartSec (80min, dazl-staging-prebuilt.service) minus a minute; the test keeps the two in step
[ $(( 65 + 60 + DOWNLOAD_BUDGET_S + BACKUP_ALLOWANCE_S + 10 + DEPLOY_ALLOWANCE_S + 60 )) -le $UNIT_LIMIT_S ] || fail "STAGING_DOWNLOAD_BUDGET_S + STAGING_BACKUP_ALLOWANCE_S + STAGING_DEPLOY_ALLOWANCE_S must leave the run inside the unit's timeout (at most $(( UNIT_LIMIT_S - 195 ))s together); nothing done"
# finding 1: root runs $DEPLOY. It and every directory above it must be a real (non-symlink) file/directory owned by root
# and writable by root only; a world-writable directory is accepted only with the sticky bit and the next component
# owned by root (like /tmp). Anything else could be replaced by another account and would run as root.
trusted_path() {
  local p=$1 st owner mode dir child
  [ -e "$p" ] && [ ! -L "$p" ] && [ -f "$p" ] || return 1
  read -r owner mode < <(stat -c '%u %a' -- "$p") || return 1
  [ "$owner" = "$TRUSTED_UID" ] && (( (8#$mode & 8#022) == 0 )) || return 1
  child=$p; dir=$(dirname -- "$p")
  while :; do
    [ ! -L "$dir" ] && [ -d "$dir" ] || return 1
    read -r owner mode < <(stat -c '%u %a' -- "$dir") || return 1
    [ "$owner" = "$TRUSTED_UID" ] || [ "$owner" = 0 ] || return 1
    if (( (8#$mode & 8#022) != 0 )); then
      (( (8#$mode & 8#1000) != 0 )) || return 1
      st=$(stat -c %u -- "$child") || return 1
      [ "$st" = "$TRUSTED_UID" ] || [ "$st" = 0 ] || return 1
    fi
    [ "$dir" = / ] && break
    child=$dir; dir=$(dirname -- "$dir")
  done
}
trusted_path "$DEPLOY" || fail "the deploy script $DEPLOY is not trusted (missing, a symlink, or it or a directory above it is not root-owned and root-writable only); install the #908 layout (docs/STAGING.md); nothing done"
grep -q 'STAGING_MIGRATE' "$DEPLOY" || fail "the deploy script $DEPLOY is from before #908 (no separate migrate step, current-sha in the service home); upgrade it first (docs/STAGING.md); nothing done"
[ -r "$ENV_FILE" ] || fail "the staging env file $ENV_FILE is not readable (run as root); nothing done"
# finding 6: deploy.sh validates the env file (staging, not production; DB path checks) before this script reads DB_PATH
bash "$DEPLOY" --check-env "$ENV_FILE" >/dev/null || fail "deploy.sh refused the env file $ENV_FILE; nothing done"
started=$(date +%s)
if [ $dry = 0 ]; then
  [ ! -L "$PSTATE" ] || fail "$PSTATE is a symlink; nothing done"
  install -d -m 700 "$PSTATE"
  exec 8>"$PSTATE/.lock"; flock -n 8 || { log "another pull is running"; exit 0; }
fi

# 1. main's head
main_sha=$(timeout --kill-after=5 60 git ls-remote "$REPO_URL" refs/heads/main 2>/dev/null | awk 'NR==1 {print $1}') || true
is_sha "$main_sha" || fail "could not read main's head commit from $REPO_URL; nothing done"

# 2. already live, recently failed, or not built yet
if [ -f "$CURRENT_FILE" ] && [ "$(cat "$CURRENT_FILE" 2>/dev/null)" = "$main_sha" ]; then
  [ $dry = 0 ] || log "dry run: $main_sha (main) is already live ($CURRENT_FILE); nothing to do"
  exit 0
fi
stamp_path="$PSTATE/failed-$main_sha"
if [ -e "$stamp_path" ] && [ $(( $(date +%s) - $(stat -c %Y "$stamp_path") )) -lt "$RETRY_AFTER_S" ]; then
  log "the deploy of $main_sha failed less than ${RETRY_AFTER_S}s ago; retrying later (delete $stamp_path to retry now)"
  exit 0
fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
manifest_name="staging-prebuilt-$main_sha.json"
# No -f here: with -f, curl's own exit 22 means ANY HTTP error >= 400, which conflates a true 404 (no build published
# yet, benign) with 403/429/5xx (a real failure that should alert). Read the actual status code instead.
st=0; http_code=$(curl -sSL --proto '=https' --max-time 60 --max-filesize 65536 -o "$tmp/manifest.json" -w '%{http_code}' "$BASE_URL/$manifest_name" 2>"$tmp/curl.err") || st=$?
[ $st = 0 ] || fail "could not fetch $manifest_name (curl exit $st): $(head -c 300 "$tmp/curl.err")"
if [ "$http_code" = 404 ]; then log "no prebuilt build published for main $main_sha yet; nothing to do"; exit 0; fi
[ "$http_code" = 200 ] || fail "could not fetch $manifest_name (HTTP $http_code): $(head -c 300 "$tmp/manifest.json")"

# 3. the manifest names exactly this commit, well-formed files, this box's architecture and Node ABI
box_arch=${STAGING_NODE_ARCH:-$(node -p process.arch)}
box_abi=${STAGING_NODE_ABI:-$(node -p process.versions.modules)}
next_sha=; read -r next_sha next_bytes mods_sha mods_bytes lock_sha < <(python3 - "$tmp/manifest.json" "$main_sha" "$box_arch" "$box_abi" "$MAX_ASSET_BYTES" <<'PY' || echo FAIL
import json, re, sys
path, sha, arch, abi, cap = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
def bad(why):
    print('staging-prebuilt: manifest refused: ' + why, file=sys.stderr); sys.exit(1)
try:
    m = json.load(open(path, 'rb'))
except Exception as e:
    bad('not JSON (%s)' % type(e).__name__)
if not isinstance(m, dict): bad('not an object')
if m.get('commit') != sha: bad('it is for %r, not main %s' % (m.get('commit'), sha))
if m.get('arch') != arch: bad('built for %r, this box is %r' % (m.get('arch'), arch))
if str(m.get('node_abi')) != abi or not isinstance(m.get('node_abi'), str): bad('Node ABI %r, this box has %r' % (m.get('node_abi'), abi))
hexsha = re.compile(r'^[0-9a-f]{64}$')
def ok_lock(v): return isinstance(v, str) and hexsha.match(v)
if not ok_lock(m.get('lock_sha256')): bad('lock_sha256 missing or malformed')
out = []
for key, name in (('next', 'staging-next-%s.tgz' % sha), ('modules', 'staging-modules-%s.tgz' % sha)):
    f = m.get(key)
    if not isinstance(f, dict): bad(key + ' missing')
    if f.get('file') != name: bad('%s file is %r, expected %s' % (key, f.get('file'), name))
    if not (isinstance(f.get('sha256'), str) and hexsha.match(f['sha256'])): bad(key + ' sha256 malformed')
    b = f.get('bytes')
    if isinstance(b, bool) or not isinstance(b, int) or b <= 0 or b > cap: bad('%s bytes %r out of range' % (key, b))
    out += [f['sha256'], str(b)]
print(' '.join(out + [m['lock_sha256']]))
PY
) || true
[[ $next_sha =~ ^[0-9a-f]{64}$ ]] || fail "the manifest of $main_sha was refused; nothing downloaded"
[ $dry = 1 ] || stamp=$stamp_path

# lockfile unchanged from the live release: deploy.sh hard-links its node_modules, so only the build is downloaded
live=; [ -L "$ROOT/current" ] && live=$(readlink -f -- "$ROOT/current")
need_mods=1
if [ -n "$live" ] && [ -f "$live/web/package-lock.json" ] && [ -d "$live/web/node_modules" ] \
   && [ "$(sha256 "$live/web/package-lock.json")" = "$lock_sha" ]; then need_mods=0; fi

# 4. disk: the downloads and the backup must leave the floor plus the reserve (deploy.sh then checks the release itself)
db=$(val DB_PATH "$ENV_FILE")
[ -n "$db" ] || fail "DB_PATH is not set in $ENV_FILE; nothing done"
# finding 6: the root-run backup reads DB_PATH; never through a symlink or a second hard link (sqlite follows symlinks)
[ ! -L "$db" ] || fail "DB_PATH $db is a symlink; nothing done"
if [ -e "$db" ]; then
  [ -f "$db" ] || fail "DB_PATH $db is not a regular file; nothing done"
  [ "$(stat -c %h -- "$db")" = 1 ] || fail "DB_PATH $db has another hard link; nothing done"
fi
db_bytes=0; [ -f "$db" ] && db_bytes=$(stat -c %s -- "$db")
need=$(( next_bytes + db_bytes )); [ $need_mods = 0 ] || need=$(( need + mods_bytes ))
probe=$DL; [ -d "$probe" ] || probe=$(dirname "$DL")
# finding 5: only an archive this run needs (and so reuses or replaces) counts as space it gets back
reuse_bytes=0; keep_names="staging-next-$main_sha.tgz"; [ $need_mods = 0 ] || keep_names="$keep_names staging-modules-$main_sha.tgz"
for n in $keep_names; do f="$DL/$n"; [ -f "$f" ] && [ ! -L "$f" ] && reuse_bytes=$(( reuse_bytes + $(stat -c %s -- "$f") )); done
avail=$(( $(df -B1 --output=avail "$probe" | tail -n 1 | tr -d ' ') + reuse_bytes ))
if [ $(( avail - need )) -lt $(( MIN_FREE_BYTES + DISK_RESERVE_BYTES )) ]; then
  log "ALERT low_disk: skipped $main_sha: $avail bytes free, the download and backup need about $need, and the floor is $MIN_FREE_BYTES plus a reserve of $DISK_RESERVE_BYTES; nothing downloaded, the live release is unchanged"
  exit 0
fi

if [ $dry = 1 ]; then
  log "dry run: main is $main_sha; live is $(basename "${live:-none}"); manifest ok (arch $box_arch, Node ABI $box_abi)"
  log "dry run: would download staging-next ($next_bytes bytes)$([ $need_mods = 1 ] && echo " and staging-modules ($mods_bytes bytes, lockfile changed)" || echo "; node_modules reused (lockfile unchanged)")"
  log "dry run: $avail bytes free, about $need needed, floor $MIN_FREE_BYTES + reserve $DISK_RESERVE_BYTES: ok"
  log "dry run: would back up $db ($db_bytes bytes) into $BACKUPS, keeping $KEEP_BACKUPS"
  log "dry run: would run $DEPLOY with the prebuilt extract as its build step"
  exit 0
fi

# 5. download and verify
[ ! -L "$DL" ] || fail "$DL is a symlink; nothing done"
install -d -m 755 "$DL"
for f in "$DL"/* "$DL"/.[!.]*; do # superseded builds and partial downloads go first
  [ -e "$f" ] || [ -L "$f" ] || continue
  case " $keep_names " in *" $(basename "$f") "*) [ -f "$f" ] && [ ! -L "$f" ] && continue ;; esac
  rm -rf -- "$f"
done
fetch() { # file expected-sha256 expected-bytes
  local f="$DL/$1"
  if [ -f "$f" ] && [ "$(stat -c %s -- "$f")" = "$3" ] && [ "$(sha256 "$f")" = "$2" ]; then log "reusing the verified $1"
  else
    rm -f -- "$f" "$f.part"
    local spent=$(( $(date +%s) - started )); [ "$spent" -ge 0 ] || spent=0 # a clock stepped back never extends the budget
    local left=$(( DOWNLOAD_BUDGET_S - spent ))
    [ "$left" -ge 30 ] || fail "the download time budget (${DOWNLOAD_BUDGET_S}s) is used up before $1; nothing deployed"
    curl -fsSL --proto '=https' --max-time "$left" --max-filesize "$3" -o "$f.part" "$BASE_URL/$1" || { rm -f -- "$f.part"; fail "download of $1 failed; nothing deployed"; }
    [ "$(stat -c %s -- "$f.part")" = "$3" ] || { rm -f -- "$f.part"; fail "$1 is not the $3 bytes the manifest records; nothing deployed"; }
    [ "$(sha256 "$f.part")" = "$2" ] || { rm -f -- "$f.part"; fail "$1 does not match the manifest's sha256; nothing deployed"; }
    mv -f -- "$f.part" "$f"
  fi
  chmod 644 "$f"
  printf '%s  %s\n' "$2" "$1" > "$f.sha256"; chmod 644 "$f.sha256"
}
fetch "staging-next-$main_sha.tgz" "$next_sha" "$next_bytes"
inner=$(tar -xzOf "$DL/staging-next-$main_sha.tgz" .build-commit 2>/dev/null || true)
[ "$inner" = "$main_sha" ] || { rm -f -- "$DL/staging-next-$main_sha.tgz"*; fail "the build says it is from ${inner:-an unknown commit}, not $main_sha; deleted, nothing deployed"; }
[ $need_mods = 0 ] || fetch "staging-modules-$main_sha.tgz" "$mods_sha" "$mods_bytes"
log "verified the prebuilt build of $main_sha (sha256 and .build-commit)"

# 6. a verified backup of the staging database, or no deploy
if [ -e "$db" ]; then
  [ ! -L "$BACKUPS" ] || fail "$BACKUPS is a symlink; nothing deployed"
  install -d -m 700 "$BACKUPS"
  out="$BACKUPS/app-pre-${main_sha:0:8}-$(date -u +%Y%m%dT%H%M%SZ).db"
  rm -f -- "$out.tmp"
  bst=0; timeout --kill-after=10 "$BACKUP_ALLOWANCE_S" python3 - "$db" "$out.tmp" <<'PY' || bst=$?
import sqlite3, sys, urllib.parse
src = sqlite3.connect('file:%s?mode=ro' % urllib.parse.quote(sys.argv[1]), uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()
r = sqlite3.connect(sys.argv[2]).execute('pragma integrity_check').fetchone()[0]
if r != 'ok': sys.exit('integrity_check: %s' % r)
PY
  if [ $bst = 124 ] || [ $bst = 137 ]; then rm -f -- "$out.tmp"; fail "the staging database backup was stopped (exit $bst: ran past its ${BACKUP_ALLOWANCE_S}s allowance, or was killed); nothing deployed"; fi
  [ $bst = 0 ] || { rm -f -- "$out.tmp"; fail "the staging database backup failed; nothing deployed"; }
  chmod 600 "$out.tmp"; mv -f -- "$out.tmp" "$out"
  ls -1t "$BACKUPS"/app-pre-*.db 2>/dev/null | tail -n +$(( KEEP_BACKUPS + 1 )) | xargs -r rm -f --
  log "backed up the staging database to $out (integrity ok)"
else log "no staging database at $db yet; nothing to back up"; fi

# 7. deploy.sh does the rest, with the verified build as its build step
self=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
build="bash '$self' --extract '$DL'"
st=0; STAGING_BUILD=$build timeout --kill-after=60 "$DEPLOY_ALLOWANCE_S" bash "$DEPLOY" 8>&- || st=$?
now=
[ -f "$CURRENT_FILE" ] && [ "$(cat "$CURRENT_FILE" 2>/dev/null)" = "$main_sha" ] && now=1
# stopped by the allowance after deploy.sh found the new release healthy and recorded it (deploy.sh writes current-sha
# only then): the commit is live, so the run reports that, not a failure
if { [ $st = 124 ] || [ $st = 137 ]; } && [ -n "$now" ]; then log "deploy.sh was stopped by its allowance after $main_sha went live"; st=0; fi
[ $st != 124 ] && [ $st != 137 ] || fail "deploy.sh was stopped (exit $st: ran past its ${DEPLOY_ALLOWANCE_S}s allowance, or was killed) for $main_sha; retrying after ${RETRY_AFTER_S}s"
[ $st = 0 ] || fail "deploy.sh failed for $main_sha (exit $st); retrying after ${RETRY_AFTER_S}s; the downloaded build is kept"
if [ -n "$now" ]; then
  rm -f -- "$PSTATE"/failed-* "$DL"/staging-*
  log "live: $main_sha"
else log "deploy.sh made no change (another deploy running, low disk, or main moved); next run retries"; fi
exit 0
