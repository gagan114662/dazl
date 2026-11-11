#!/usr/bin/env bash
# Staging auto-deploy from a prebuilt build (docs/STAGING.md, "Automatic deploys from prebuilt builds").
# The staging box (1.8 GB RAM, 2 CPUs) cannot run `next build`, so the build happens on a free GitHub-hosted runner
# (.github/workflows/staging-prebuilt.yml, on every push to main) and is published as assets of the `staging-prebuilt`
# prerelease of this public repo. Run by dazl-staging-prebuilt.timer every 2 minutes, as root, this script:
#   1. reads main's head commit (git ls-remote, no token: the repo is public);
#   2. does nothing when that commit is already live (the deploy's current-sha file) or failed less than
#      STAGING_RETRY_AFTER_S ago, or when no prebuilt build has been published for it yet;
#   3. reads the build's manifest (staging-prebuilt-<sha>.json, uploaded last, so a manifest means a complete set) and
#      checks it names exactly that commit, this box's CPU architecture and Node ABI;
#   4. skips (journal ALERT) when the downloads plus a database backup would take free space below the 2 GiB floor
#      plus a reserve, before downloading anything;
#   5. downloads the build (and node_modules only when the lockfile differs from the live release's), checks each
#      file's size and sha256 against the manifest and the commit recorded inside the build (.build-commit);
#   6. backs up the staging SQLite database (online backup API, integrity_check ok) into a root-only directory,
#      keeping the newest STAGING_KEEP_BACKUPS; no verified backup, no deploy;
#   7. runs the installed deploy.sh with STAGING_BUILD replaced by `pull-prebuilt.sh --extract`: deploy.sh keeps doing
#      everything else (env checks, disk floor, release dir, migrate + seed, health check, rollback, and keeping the
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
# The installed deploy script (root-owned). A box still on the layout from before #908 runs /srv/dazl-staging/deploy.sh.
DEPLOY=${STAGING_DEPLOY_SH:-/usr/local/lib/dazl-staging/deploy.sh}
# Downloads: root-owned, world-readable (the extract step runs as the service user), never writable by it.
DL=${STAGING_PREBUILT_DIR:-/var/cache/dazl-staging-prebuilt}
# This script's own state (lock, failure stamps): root-only.
PSTATE=${STAGING_PREBUILT_STATE:-/var/lib/dazl-staging-prebuilt}
BACKUPS=${STAGING_BACKUP_DIR:-/var/lib/dazl-staging-backups}
KEEP_BACKUPS=${STAGING_KEEP_BACKUPS:-3}
# Where deploy.sh records the live commit: the current layout, then the pre-#908 one.
CURRENT_FILES=${STAGING_CURRENT_SHA_FILES:-/var/lib/dazl-staging-deploy/current-sha $ROOT/current-sha}
MIN_FREE_BYTES=${MIN_FREE_BYTES:-2147483648}
DISK_RESERVE_BYTES=${DISK_RESERVE_BYTES:-268435456}
RETRY_AFTER_S=${STAGING_RETRY_AFTER_S:-1800}
MAX_ASSET_BYTES=${STAGING_MAX_ASSET_BYTES:-2000000000}
MIGRATE_STEP='npm run -s db:migrate && node --experimental-strip-types --no-warnings scripts/staging-seed.mts'

log() { echo "staging-prebuilt: $*"; }
fail() { echo "staging-prebuilt: $*" >&2; exit 1; }
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

[ -f "$DEPLOY" ] || fail "the deploy script $DEPLOY is not installed (docs/STAGING.md); nothing done"
[ -r "$ENV_FILE" ] || fail "the staging env file $ENV_FILE is not readable (run as root); nothing done"
if [ $dry = 0 ]; then
  [ ! -L "$PSTATE" ] || fail "$PSTATE is a symlink; nothing done"
  install -d -m 700 "$PSTATE"
  exec 8>"$PSTATE/.lock"; flock -n 8 || { log "another pull is running"; exit 0; }
fi

# 1. main's head
main_sha=$(git ls-remote "$REPO_URL" refs/heads/main 2>/dev/null | awk 'NR==1 {print $1}') || true
is_sha "$main_sha" || fail "could not read main's head commit from $REPO_URL; nothing done"

# 2. already live, recently failed, or not built yet
for f in $CURRENT_FILES; do
  if [ -f "$f" ] && [ "$(cat "$f" 2>/dev/null)" = "$main_sha" ]; then
    [ $dry = 0 ] || log "dry run: $main_sha (main) is already live ($f); nothing to do"
    exit 0
  fi
done
stamp="$PSTATE/failed-$main_sha"
if [ -e "$stamp" ] && [ $(( $(date +%s) - $(stat -c %Y "$stamp") )) -lt "$RETRY_AFTER_S" ]; then
  log "the deploy of $main_sha failed less than ${RETRY_AFTER_S}s ago; retrying later (delete $stamp to retry now)"
  exit 0
fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
manifest_name="staging-prebuilt-$main_sha.json"
st=0; curl -fsSL --proto '=https' --max-time 60 --max-filesize 65536 -o "$tmp/manifest.json" "$BASE_URL/$manifest_name" 2>"$tmp/curl.err" || st=$?
if [ $st = 22 ]; then log "no prebuilt build published for main $main_sha yet; nothing to do"; exit 0; fi
[ $st = 0 ] || fail "could not fetch $manifest_name (curl exit $st): $(head -c 300 "$tmp/curl.err")"

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

# lockfile unchanged from the live release: deploy.sh hard-links its node_modules, so only the build is downloaded
live=; [ -L "$ROOT/current" ] && live=$(readlink -f -- "$ROOT/current")
need_mods=1
if [ -n "$live" ] && [ -f "$live/web/package-lock.json" ] && [ -d "$live/web/node_modules" ] \
   && [ "$(sha256 "$live/web/package-lock.json")" = "$lock_sha" ]; then need_mods=0; fi

# 4. disk: the downloads and the backup must leave the floor plus the reserve (deploy.sh then checks the release itself)
db=$(val DB_PATH "$ENV_FILE")
[ -n "$db" ] || fail "DB_PATH is not set in $ENV_FILE; nothing done"
db_bytes=0; [ -f "$db" ] && db_bytes=$(stat -c %s -- "$db")
need=$(( next_bytes + db_bytes )); [ $need_mods = 0 ] || need=$(( need + mods_bytes ))
probe=$DL; [ -d "$probe" ] || probe=$(dirname "$DL")
reuse_bytes=0; for f in "$DL/staging-next-$main_sha.tgz" "$DL/staging-modules-$main_sha.tgz"; do [ -f "$f" ] && reuse_bytes=$(( reuse_bytes + $(stat -c %s -- "$f") )); done
avail=$(( $(df -B1 --output=avail "$probe" | tail -n 1 | tr -d ' ') + reuse_bytes ))
if [ $(( avail - need )) -lt $(( MIN_FREE_BYTES + DISK_RESERVE_BYTES )) ]; then
  log "ALERT low_disk: skipped $main_sha: $avail bytes free, the download and backup need about $need, and the floor is $MIN_FREE_BYTES plus a reserve of $DISK_RESERVE_BYTES; nothing downloaded, the live release is unchanged"
  exit 0
fi
if grep -q 'STAGING_MIGRATE' "$DEPLOY"; then migrate_in_build=0; else migrate_in_build=1; fi

if [ $dry = 1 ]; then
  log "dry run: main is $main_sha; live is $(basename "${live:-none}"); manifest ok (arch $box_arch, Node ABI $box_abi)"
  log "dry run: would download staging-next ($next_bytes bytes)$([ $need_mods = 1 ] && echo " and staging-modules ($mods_bytes bytes, lockfile changed)" || echo "; node_modules reused (lockfile unchanged)")"
  log "dry run: $avail bytes free, about $need needed, floor $MIN_FREE_BYTES + reserve $DISK_RESERVE_BYTES: ok"
  log "dry run: would back up $db ($db_bytes bytes) into $BACKUPS, keeping $KEEP_BACKUPS"
  log "dry run: would run $DEPLOY with the prebuilt extract as its build step$([ $migrate_in_build = 1 ] && echo ", migrate and seed included (deploy.sh from before #908)")"
  exit 0
fi

# 5. download and verify
[ ! -L "$DL" ] || fail "$DL is a symlink; nothing done"
install -d -m 755 "$DL"
for f in "$DL"/* "$DL"/.[!.]*; do # superseded builds and partial downloads go first
  [ -e "$f" ] || [ -L "$f" ] || continue
  case "$(basename "$f")" in "staging-next-$main_sha.tgz"|"staging-modules-$main_sha.tgz") [ -f "$f" ] && [ ! -L "$f" ] && continue ;; esac
  rm -rf -- "$f"
done
fetch() { # file expected-sha256 expected-bytes
  local f="$DL/$1"
  if [ -f "$f" ] && [ "$(stat -c %s -- "$f")" = "$3" ] && [ "$(sha256 "$f")" = "$2" ]; then log "reusing the verified $1"
  else
    rm -f -- "$f" "$f.part"
    curl -fsSL --proto '=https' --retry 2 --max-time 1800 --max-filesize "$3" -o "$f.part" "$BASE_URL/$1" || { rm -f -- "$f.part"; fail "download of $1 failed; nothing deployed"; }
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
  python3 - "$db" "$out.tmp" <<'PY' || { rm -f -- "$out.tmp"; fail "the staging database backup failed; nothing deployed"; }
import sqlite3, sys, urllib.parse
src = sqlite3.connect('file:%s?mode=ro' % urllib.parse.quote(sys.argv[1]), uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()
r = sqlite3.connect(sys.argv[2]).execute('pragma integrity_check').fetchone()[0]
if r != 'ok': sys.exit('integrity_check: %s' % r)
PY
  chmod 600 "$out.tmp"; mv -f -- "$out.tmp" "$out"
  ls -1t "$BACKUPS"/app-pre-*.db 2>/dev/null | tail -n +$(( KEEP_BACKUPS + 1 )) | xargs -r rm -f --
  log "backed up the staging database to $out (integrity ok)"
else log "no staging database at $db yet; nothing to back up"; fi

# 7. deploy.sh does the rest, with the verified build as its build step
self=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
build="bash '$self' --extract '$DL'"
[ $migrate_in_build = 0 ] || build="$build && $MIGRATE_STEP"
st=0; STAGING_BUILD=$build bash "$DEPLOY" 8>&- || st=$?
now=
for f in $CURRENT_FILES; do [ -f "$f" ] && [ "$(cat "$f" 2>/dev/null)" = "$main_sha" ] && now=1; done
if [ $st != 0 ]; then
  touch "$stamp"
  fail "deploy.sh failed for $main_sha (exit $st); retrying after ${RETRY_AFTER_S}s; the downloaded build is kept"
fi
if [ -n "$now" ]; then
  rm -f -- "$PSTATE"/failed-* "$DL"/staging-*
  log "live: $main_sha"
else log "deploy.sh made no change (another deploy running, low disk, or main moved); next run retries"; fi
exit 0
