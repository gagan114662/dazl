#!/usr/bin/env bash
# Sends ONE test message to the ops alert destination, so the owner can see that alerts arrive (issue #1088):
#
#   sudo /usr/local/lib/dazl-uptime/send-test-alert.sh          # the installed probe's destination (/etc/dazl-uptime/env)
#   ops/uptime/send-test-alert.sh ~/.config/dazl-uptime/env     # another env file (the user-unit install)
#   OPS_ALERT_WEBHOOK_URL='<the URL>' ops/uptime/send-test-alert.sh -     # no file: the URL from the environment
#
# Exit 0 and "delivered": the destination accepted it (look for "dazl test alert from <host>"). Exit 1: it did not, and
# the line above says why (no destination, an unusable URL, or the HTTP status). The URL is never printed.
# The env file is read as data, never executed: only its OPS_ALERT_WEBHOOK_URL=... line is used.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ $# -le 1 ] || { echo "usage: send-test-alert.sh [env-file | -]" >&2; exit 2; }
ENV_FILE=${1:-/etc/dazl-uptime/env}
if [ "$ENV_FILE" != - ]; then
  [ -r "$ENV_FILE" ] || { echo "send-test-alert: cannot read $ENV_FILE (run with sudo, or name the env file)" >&2; exit 1; }
  url=$(sed -n 's/^OPS_ALERT_WEBHOOK_URL=//p' "$ENV_FILE" | tail -n 1)
  url=${url%$'\r'}; url=${url#[\"\']}; url=${url%[\"\']}
  [ -n "$url" ] || { echo "send-test-alert: $ENV_FILE has no OPS_ALERT_WEBHOOK_URL=... line" >&2; exit 1; }
  export OPS_ALERT_WEBHOOK_URL=$url
fi
if node "$HERE/probe.mjs" --test-alert; then echo "send-test-alert: delivered"
else echo "send-test-alert: NOT delivered" >&2; exit 1; fi
