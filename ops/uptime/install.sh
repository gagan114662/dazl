#!/usr/bin/env bash
# Installs the uptime probe as a systemd SYSTEM timer (issues #1088, #1090). Run once, as root, from a reviewed checkout:
#
#   sudo ops/uptime/install.sh
#
# It copies probe.mjs and send-test-alert.sh to /usr/local/lib/dazl-uptime/, the unit and timer to /etc/systemd/system/
# (dazl-uptime-system.service is installed as dazl-uptime.service), creates an EMPTY /etc/dazl-uptime/env (root, mode
# 600) when there is none, and enables the timer. It never writes the alert URL and never replaces an existing env file:
# the operator puts ONE line in it, OPS_ALERT_WEBHOOK_URL=<the alert URL>, then runs send-test-alert.sh.
# Run it again after probe.mjs changes: it replaces the copies and reloads systemd.
# Tests: UPTIME_ROOT=<dir> installs under that directory instead of /, UPTIME_SYSTEMCTL=<command> replaces systemctl.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=${UPTIME_ROOT:-}
SYSTEMCTL=${UPTIME_SYSTEMCTL:-systemctl}
[ $# -eq 0 ] || { echo "usage: install.sh (no arguments)" >&2; exit 2; }
[ -n "$ROOT" ] || [ "$(id -u)" = 0 ] || { echo "install.sh: run as root (sudo ops/uptime/install.sh)" >&2; exit 1; }
command -v node >/dev/null || { echo "install.sh: node is not on PATH (the probe needs Node 20+); nothing installed" >&2; exit 1; }
LIB=$ROOT/usr/local/lib/dazl-uptime UNITS=$ROOT/etc/systemd/system ETC=$ROOT/etc/dazl-uptime
install -d -m 755 "$LIB" "$UNITS"
install -d -m 700 "$ETC"
install -m 644 "$HERE/probe.mjs" "$LIB/probe.mjs"
install -m 755 "$HERE/send-test-alert.sh" "$LIB/send-test-alert.sh"
install -m 644 "$HERE/dazl-uptime-system.service" "$UNITS/dazl-uptime.service"
install -m 644 "$HERE/dazl-uptime.timer" "$UNITS/dazl-uptime.timer"
if [ -e "$ETC/env" ]; then echo "install.sh: $ETC/env kept as it is"
else install -m 600 /dev/null "$ETC/env"; echo "install.sh: created an empty $ETC/env: put one line in it, OPS_ALERT_WEBHOOK_URL=<the alert URL>"; fi
$SYSTEMCTL daemon-reload
$SYSTEMCTL enable --now dazl-uptime.timer
echo "install.sh: installed. Next: $LIB/send-test-alert.sh   (one test message must arrive)"
