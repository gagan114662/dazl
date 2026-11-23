#!/bin/bash
# Installs dazl's downtime probe on the box (issue #1088) with the repo's own installer from the LIVE production
# release, points it at the alert destination production already uses, and sends ONE test message there.
# Run from the owner's Mac.
#
#   DAZL_SSH_HOST=<ssh alias or user@host of the box> ops/owner/install-downtime-alert.sh
#
# Adds: /usr/local/lib/dazl-uptime/, /etc/dazl-uptime/env, and the systemd timer dazl-uptime.timer. Touches nothing else.
# Every URL in the output is replaced with <url>, so the alert destination is never shown.
# To undo: sudo systemctl disable --now dazl-uptime.timer && sudo rm -rf /usr/local/lib/dazl-uptime /etc/dazl-uptime /etc/systemd/system/dazl-uptime.*
# A probe on the box itself does not see the box being off: issue #1586 is the off-host one.
set -euo pipefail
: "${DAZL_SSH_HOST:?set DAZL_SSH_HOST to the ssh alias or user@host of the box}"
ssh -o ConnectTimeout=10 -o BatchMode=yes -- "$DAZL_SSH_HOST" 'sudo bash -s' <<'EOF' 2>&1 | sed -E 's#https?://[^ ]+#<url>#g'
set -e
REL=$(for d in $(sed -n 's/^DAZL_RELEASE=//p' /etc/dazl-prod/ports/*.conf); do [ -f "$d/ops/uptime/install.sh" ] && echo "$d"; done | head -1)
[ -n "$REL" ] || { echo "FAIL: no live release contains ops/uptime/install.sh; nothing changed"; exit 1; }
echo "installer from: $REL"
bash "$REL/ops/uptime/install.sh"
if ! grep -qE '^OPS_ALERT_WEBHOOK_URL=.' /etc/dazl-uptime/env; then grep -E '^OPS_ALERT_WEBHOOK_URL=' /etc/dazl-ops/prod.env | head -1 > /etc/dazl-uptime/env; chmod 600 /etc/dazl-uptime/env; fi
echo "env lines: $(grep -c . /etc/dazl-uptime/env), mode $(stat -c %a /etc/dazl-uptime/env)"
echo "--- test alert ---"
RC=0; /usr/local/lib/dazl-uptime/send-test-alert.sh || RC=$?
echo "test alert exit=$RC"
echo "--- first probe run ---"
systemctl start dazl-uptime.service || true
sleep 6
systemctl show dazl-uptime.service -p Result -p ExecMainStatus | tr '\n' ' '; echo
journalctl -u dazl-uptime.service -n 8 --no-pager -o cat
systemctl list-timers --no-pager | grep -i uptime
EOF
