#!/usr/bin/env bash
# Prints the directory of the release that serves production right now (issue #1080), for jobs that must run the LIVE
# release's own scripts (the hourly backup, the backup check) although every deploy moves it to a new directory.
# Read-only. The same two facts ops/prod/deploy-prod.sh keeps:
#   1. the port Caddy sends the site to (the site block's `reverse_proxy localhost:<port>`), and
#   2. /etc/dazl-prod/ports/<port>.conf, whose DAZL_RELEASE line is the release directory that port's unit runs.
# Exit 0 and one line (the directory) when both agree on a complete release; exit 1 and the reason otherwise: a job that
# cannot tell which release is live must fail loudly, never guess an old one.
#   LIVE_CADDYFILE (/etc/caddy/Caddyfile)  LIVE_CADDY_SITE ("dazl.ai, www.dazl.ai")  LIVE_PORTCONF_DIR (/etc/dazl-prod/ports)
set -euo pipefail
CADDY=${LIVE_CADDYFILE:-/etc/caddy/Caddyfile}
SITE=${LIVE_CADDY_SITE:-dazl.ai, www.dazl.ai}
PORTCONF=${LIVE_PORTCONF_DIR:-/etc/dazl-prod/ports}
die() { echo "live-release: $1" >&2; exit 1; }
[ -r "$CADDY" ] || die "cannot read $CADDY"
port=$(python3 - "$CADDY" "$SITE" <<'PY'
import re, sys
m = re.search(re.escape(sys.argv[2]) + r' \{[^}]*?reverse_proxy localhost:(\d+)', open(sys.argv[1]).read())
print(m.group(1) if m else '')
PY
)
[[ $port =~ ^31[0-9]{2}$ ]] || die "the site block \"$SITE\" in $CADDY names no reverse_proxy localhost:31xx port"
conf=$PORTCONF/$port.conf
[ -r "$conf" ] || die "no $conf: port $port has no recorded release (a pre-v2 process?)"
dir=$(sed -n 's/^DAZL_RELEASE=//p' "$conf" | head -1)
[[ $dir =~ ^/[A-Za-z0-9._/-]+/dazl-[0-9a-f]{8}-prod$ ]] || die "DAZL_RELEASE in $conf is not a release directory: '${dir}'"
[ -f "$dir/web/scripts/backup/create-backup.ts" ] && [ -f "$dir/ops/backup/run-backup.sh" ] || die "$dir is not a complete release (no backup scripts in it)"
printf '%s\n' "$dir"
