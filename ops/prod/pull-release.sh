#!/usr/bin/env bash
# Production releases from a prebuilt build (web/docs/DEPLOY.md, "Deploying a prebuilt release").
# The production box (1.8 GB RAM) must never run `npm ci`, tsc or `next build`: on 2026-11-12 a deploy that built on the
# box was OOM-killed and dazl.ai answered 502 for about 6 minutes. The build runs on a free GitHub-hosted runner
# (.github/workflows/prod-prebuilt.yml) and is published as public assets of the `prod-prebuilt` prerelease. This script
# only downloads, verifies and unpacks it; nothing here installs or compiles anything.
#
#   pull-release.sh fetch <sha>
#       (root) reads the manifest prod-prebuilt-<sha>.json (uploaded last: a manifest means a complete set), checks it
#       names exactly <sha>, this box's CPU architecture and Node ABI; refuses when the downloads plus the unpacked build
#       would leave less than PROD_MIN_FREE_BYTES (3 GiB) free; downloads both archives within one time budget, checks
#       size, sha256 and the commit inside the build (.build-commit), and records each verified file's sha256 beside it.
#   pull-release.sh extract <sha> <web-dir> [<live-web-dir>]
#       (the app user) in a source checkout of <sha> (<web-dir> = its web/): checks its package-lock.json is the one the
#       build was made from, unpacks .next and .build-commit, and node_modules: hard-linked from <live-web-dir> when
#       that release has the same lockfile, else unpacked from the verified archive. Refuses unless everything verifies.
# Exit 0 = done; anything else = nothing usable was produced (the caller must not start the release).
set -euo pipefail

REPO=${PROD_PREBUILT_REPO:-gagan114662/dazl}
TAG=${PROD_PREBUILT_TAG:-prod-prebuilt}
BASE_URL=${PROD_PREBUILT_BASE_URL:-https://github.com/$REPO/releases/download/$TAG}
# Downloads: root-owned, world-readable (extract runs as the app user), never writable by it.
DL=${PROD_PREBUILT_DIR:-/var/cache/dazl-prod-prebuilt}
MIN_FREE_BYTES=${PROD_MIN_FREE_BYTES:-3221225472}
MAX_ASSET_BYTES=${PROD_MAX_ASSET_BYTES:-2000000000}
DOWNLOAD_BUDGET_S=${PROD_DOWNLOAD_BUDGET_S:-1800}

log() { echo "prod-prebuilt: $*"; }
fail() { echo "prod-prebuilt: $*" >&2; exit 1; }
is_sha() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]]; }
sha256() { sha256sum -- "$1" | cut -c1-64; }

# The manifest, validated: prints "next_sha next_bytes next_unpacked mods_sha mods_bytes mods_unpacked lock_sha", or fails.
manifest() { # file sha arch abi
  python3 - "$1" "$2" "$3" "$4" "$MAX_ASSET_BYTES" <<'PY'
import json, re, sys
path, sha, arch, abi, cap = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
def bad(why):
    print('prod-prebuilt: manifest refused: ' + why, file=sys.stderr); sys.exit(1)
try:
    m = json.load(open(path, 'rb'))
except Exception as e:
    bad('not JSON (%s)' % type(e).__name__)
if not isinstance(m, dict): bad('not an object')
if m.get('commit') != sha: bad('it is for %r, not %s' % (m.get('commit'), sha))
if m.get('arch') != arch: bad('built for %r, this box is %r' % (m.get('arch'), arch))
if not isinstance(m.get('node_abi'), str) or m['node_abi'] != abi: bad('Node ABI %r, this box has %r' % (m.get('node_abi'), abi))
hexsha = re.compile(r'^[0-9a-f]{64}$')
if not (isinstance(m.get('lock_sha256'), str) and hexsha.match(m['lock_sha256'])): bad('lock_sha256 missing or malformed')
def size(v, what):
    if isinstance(v, bool) or not isinstance(v, int) or v <= 0 or v > cap: bad('%s %r out of range' % (what, v))
    return v
out = []
for key, name in (('next', 'prod-next-%s.tgz' % sha), ('modules', 'prod-modules-%s.tgz' % sha)):
    f = m.get(key)
    if not isinstance(f, dict): bad(key + ' missing')
    if f.get('file') != name: bad('%s file is %r, expected %s' % (key, f.get('file'), name))
    if not (isinstance(f.get('sha256'), str) and hexsha.match(f['sha256'])): bad(key + ' sha256 malformed')
    out += [f['sha256'], str(size(f.get('bytes'), key + ' bytes')), str(size(f.get('unpacked_bytes'), key + ' unpacked_bytes'))]
print(' '.join(out + [m['lock_sha256']]))
PY
}

fetch() {
  local sha=$1 tmp st code box_arch box_abi next_sha next_bytes next_unp mods_sha mods_bytes mods_unp lock_sha
  is_sha "$sha" || fail "fetch: '$sha' is not a full commit; nothing done"
  [ ! -L "$DL" ] || fail "$DL is a symlink; nothing done"
  [[ $DOWNLOAD_BUDGET_S =~ ^[0-9]+$ ]] || fail "PROD_DOWNLOAD_BUDGET_S must be a whole number of seconds; nothing done"
  local started; started=$(date +%s)
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  st=0; code=$(curl -sSL --proto '=https' --max-time 60 --max-filesize 65536 -o "$tmp/m.json" -w '%{http_code}' "$BASE_URL/prod-prebuilt-$sha.json" 2>"$tmp/err") || st=$?
  [ $st = 0 ] || fail "could not fetch the manifest of $sha (curl exit $st): $(head -c 300 "$tmp/err")"
  [ "$code" != 404 ] || fail "no prebuilt build is published for $sha: run the prod-prebuilt workflow for it (workflow_dispatch, sha=$sha); nothing done"
  [ "$code" = 200 ] || fail "could not fetch the manifest of $sha (HTTP $code); nothing done"
  box_arch=${PROD_NODE_ARCH:-$(node -p process.arch)}; box_abi=${PROD_NODE_ABI:-$(node -p process.versions.modules)}
  read -r next_sha next_bytes next_unp mods_sha mods_bytes mods_unp lock_sha < <(manifest "$tmp/m.json" "$sha" "$box_arch" "$box_abi" || echo FAIL)
  [[ ${next_sha:-} =~ ^[0-9a-f]{64}$ ]] || fail "the manifest of $sha was refused; nothing downloaded"
  # the disk floor: what is still to download, plus both archives unpacked, must leave PROD_MIN_FREE_BYTES free
  install -d -m 755 "$DL"
  local have=0 n
  for n in "prod-next-$sha.tgz:$next_sha" "prod-modules-$sha.tgz:$mods_sha"; do
    local f="$DL/${n%%:*}"; [ -f "$f" ] && [ ! -L "$f" ] && [ "$(sha256 "$f")" = "${n##*:}" ] && have=$(( have + $(stat -c %s -- "$f") ))
  done
  local need=$(( next_bytes + mods_bytes - have + next_unp + mods_unp ))
  # both filesystems: the download cache and where the release is unpacked (often the same; then all of it counts there)
  local fs avail rel_fs dl_dev rel_dev
  rel_fs=${PROD_RELEASE_ROOT:-/home/ubuntu}; [ -d "$rel_fs" ] || rel_fs=/
  dl_dev=$(stat -c %d -- "$DL"); rel_dev=$(stat -c %d -- "$rel_fs")
  for fs in "$DL" "$rel_fs"; do
    local here=$need
    if [ "$dl_dev" != "$rel_dev" ]; then
      if [ "$fs" = "$DL" ]; then here=$(( next_bytes + mods_bytes - have )); else here=$(( next_unp + mods_unp )); fi
    fi
    avail=$(df -B1 --output=avail "$fs" | tail -n 1 | tr -d ' ')
    if [ $(( avail - here )) -lt "$MIN_FREE_BYTES" ]; then
      fail "ALERT low_disk: $avail bytes free on $fs, the release needs about $here there (downloads plus the unpacked build), and the box keeps $MIN_FREE_BYTES free; nothing downloaded, nothing changed"
    fi
  done
  # superseded downloads go first (only this commit's verified files are kept)
  for f in "$DL"/* "$DL"/.[!.]*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    case "$(basename "$f")" in "prod-next-$sha.tgz"|"prod-modules-$sha.tgz") [ -f "$f" ] && [ ! -L "$f" ] && continue ;; esac
    rm -rf -- "$f"
  done
  get() { # name sha256 bytes
    local f="$DL/$1" spent left
    if [ -f "$f" ] && [ "$(stat -c %s -- "$f")" = "$3" ] && [ "$(sha256 "$f")" = "$2" ]; then log "reusing the verified $1"
    else
      rm -f -- "$f" "$f.part"
      spent=$(( $(date +%s) - started )); [ "$spent" -ge 0 ] || spent=0
      left=$(( DOWNLOAD_BUDGET_S - spent ))
      [ "$left" -ge 30 ] || fail "the download time budget (${DOWNLOAD_BUDGET_S}s) is used up before $1; nothing changed"
      curl -fsSL --proto '=https' --max-time "$left" --max-filesize "$3" -o "$f.part" "$BASE_URL/$1" || { rm -f -- "$f.part"; fail "download of $1 failed; nothing changed"; }
      [ "$(stat -c %s -- "$f.part")" = "$3" ] || { rm -f -- "$f.part"; fail "$1 is not the $3 bytes the manifest records; nothing changed"; }
      [ "$(sha256 "$f.part")" = "$2" ] || { rm -f -- "$f.part"; fail "$1 does not match the manifest's sha256; nothing changed"; }
      mv -f -- "$f.part" "$f"
    fi
    chmod 644 "$f"; printf '%s  %s\n' "$2" "$1" > "$f.sha256"; chmod 644 "$f.sha256"
  }
  get "prod-next-$sha.tgz" "$next_sha" "$next_bytes"
  local inner; inner=$(tar -xzOf "$DL/prod-next-$sha.tgz" .build-commit 2>/dev/null || true)
  [ "$inner" = "$sha" ] || { rm -f -- "$DL/prod-next-$sha.tgz"*; fail "the build says it is from ${inner:-an unknown commit}, not $sha; deleted, nothing changed"; }
  get "prod-modules-$sha.tgz" "$mods_sha" "$mods_bytes"
  printf '%s\n' "$lock_sha" > "$DL/prod-lock-$sha.sha256"; chmod 644 "$DL/prod-lock-$sha.sha256"
  log "verified the prebuilt build of $sha (sha256, sizes, .build-commit)"
}

extract() {
  local sha=$1 web=$2 live=${3:-} next mods lock want
  is_sha "$sha" || fail "extract: '$sha' is not a full commit; nothing extracted"
  [ -d "$web" ] && [ ! -L "$web" ] || fail "extract: $web is not a directory; nothing extracted"
  next="$DL/prod-next-$sha.tgz"; mods="$DL/prod-modules-$sha.tgz"; lock="$DL/prod-lock-$sha.sha256"
  [ -f "$next.sha256" ] && [ -f "$mods.sha256" ] && [ -f "$lock" ] || fail "extract: no verified prebuilt build of $sha (run fetch first); nothing extracted"
  (cd "$DL" && sha256sum --quiet -c -- "$(basename "$next").sha256" && sha256sum --quiet -c -- "$(basename "$mods").sha256") || fail "extract: an archive no longer matches its recorded sha256; nothing extracted"
  want=$(cat "$lock")
  [ -f "$web/package-lock.json" ] && [ "$(sha256 "$web/package-lock.json")" = "$want" ] || fail "extract: $web/package-lock.json is not the lockfile the build of $sha was made from (wrong checkout?); nothing extracted"
  [ "$(tar -xzOf "$next" .build-commit 2>/dev/null || true)" = "$sha" ] || fail "extract: the build is not from $sha; nothing extracted"
  rm -rf -- "$web/.next" "$web/node_modules"
  tar -xzf "$next" -C "$web" --no-same-owner --no-same-permissions .next .build-commit
  if [ -n "$live" ] && [ -d "$live/node_modules" ] && [ -f "$live/package-lock.json" ] && [ "$(sha256 "$live/package-lock.json")" = "$want" ]; then
    cp -al -- "$live/node_modules" "$web/node_modules"
    log "node_modules hard-linked from the live release (same lockfile)"
  else
    tar -xzf "$mods" -C "$web" --no-same-owner --no-same-permissions node_modules
  fi
  [ "$(cat "$web/.build-commit")" = "$sha" ] && [ -f "$web/.next/BUILD_ID" ] && [ -f "$web/node_modules/next/package.json" ] || { rm -rf -- "$web/.next" "$web/node_modules"; fail "extract: the unpacked release is incomplete; removed"; }
  log "extracted the prebuilt build of $sha into $web"
}

case "${1:-}" in
  fetch) fetch "${2:-}" ;;
  extract) extract "${2:-}" "${3:-}" "${4:-}" ;;
  *) fail "usage: pull-release.sh fetch <sha> | extract <sha> <web-dir> [<live-web-dir>]" ;;
esac
