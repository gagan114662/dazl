#!/usr/bin/env bash
# Compares the production deploy scripts INSTALLED on the box with the copies in this repository (ops/prod/), by sha256.
# Read-only: it changes nothing and installs nothing. Exit 0 = every file is identical; exit 1 = a file differs or is
# missing, and it says which; exit 2 = bad usage. Run it on the box (or give it a directory of copies to check):
#
#   ops/prod/check-installed.sh                 # compares /usr/local/lib/dazl-prod/* with this checkout's ops/prod/*
#   ops/prod/check-installed.sh /some/dir       # compares /some/dir/* instead
#
# With no argument it also compares the systemd unit template /etc/systemd/system/dazl-prod@.service (#1083).
# PROD_UNIT_DIR=<dir> looks for the unit in that directory instead (and makes a run with a directory argument check it too).
#
# Why: the box's deploy script is run as root by the ops door. If the installed copy is not exactly a reviewed file
# from this repository, nobody has reviewed what runs (NEVER-AGAIN #2, #1140).
set -euo pipefail
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALLED=${1:-/usr/local/lib/dazl-prod}
FILES=(deploy-prod.sh pull-release.sh run-release.sh check-pages.py check-hydration.mjs)
UNIT=dazl-prod@.service
UNIT_DIR=${PROD_UNIT_DIR:-}; [ $# -ge 1 ] || UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}
[ $# -le 1 ] || { echo "usage: check-installed.sh [installed-dir]" >&2; exit 2; }
[ -d "$INSTALLED" ] || { echo "check-installed: $INSTALLED is not a directory" >&2; exit 1; }
bad=0
compare() {  # $1 = file name, $2 = the directory it is installed in
  local f=$1 dir=$2 want have
  want=$(sha256sum -- "$REPO_DIR/$f" | cut -c1-64)
  if [ ! -f "$dir/$f" ] || [ -L "$dir/$f" ]; then
    echo "$f: MISSING in $dir (repo $want)"; bad=1; return 0
  fi
  have=$(sha256sum -- "$dir/$f" | cut -c1-64)
  if [ "$have" = "$want" ]; then echo "$f: installed = repo ($want)"
  else echo "$f: DIFFERS: installed $have, repo $want"; bad=1; fi
}
for f in "${FILES[@]}"; do compare "$f" "$INSTALLED"; done
[ -z "$UNIT_DIR" ] || compare "$UNIT" "$UNIT_DIR"
[ $bad = 0 ] || { echo "check-installed: the installed deploy scripts are NOT the reviewed ones in ops/prod/"; exit 1; }
echo "check-installed: every installed deploy script${UNIT_DIR:+ and the unit template} is the reviewed repo copy"
