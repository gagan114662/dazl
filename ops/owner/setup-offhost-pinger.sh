#!/bin/bash
# Turns on the off-server downtime check (issue #1586, .github/workflows/offhost-uptime.yml): copies the alert
# destination production already uses into the GitHub repo secret OPS_ALERT_WEBHOOK_URL and starts one run that sends
# ONE test message. Run from the owner's Mac, inside a checkout of this repository, with `gh` signed in as the owner.
#
#   DAZL_SSH_HOST=<ssh alias or user@host of the box> ops/owner/setup-offhost-pinger.sh
#
# Until this has run once the repository has no such secret, and the check goes red on downtime WITHOUT alerting.
# Send the test alert again later with: gh workflow run offhost-uptime.yml -f test_alert=true
#
# Reads one line of /etc/dazl-uptime/env on the box (written by install-downtime-alert.sh). Changes nothing on the
# box. The destination goes from ssh into this script's memory and from there to `gh secret set` on stdin: it is never
# printed, written to a file or put on a command line.
# To undo: gh secret delete OPS_ALERT_WEBHOOK_URL && gh workflow disable offhost-uptime.yml
set -euo pipefail
: "${DAZL_SSH_HOST:?set DAZL_SSH_HOST to the ssh alias or user@host of the box}"
command -v gh >/dev/null || { echo "FAIL: gh (the GitHub command line tool) is not installed; nothing changed" >&2; exit 1; }
URL=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -- "$DAZL_SSH_HOST" "sudo sed -n 's/^OPS_ALERT_WEBHOOK_URL=//p' /etc/dazl-uptime/env | tail -n 1")
URL=${URL%$'\r'}; URL=${URL#[\"\']}; URL=${URL%[\"\']}
case "$URL" in
  https://api.telegram.org/bot*/sendMessage\?chat_id=*) ;;
  '') echo "FAIL: the box has no alert destination in /etc/dazl-uptime/env (run install-downtime-alert.sh first); nothing changed" >&2; exit 1 ;;
  *) echo "FAIL: the box's alert destination is not a Telegram bot address, which is all the off-server check can send to; nothing changed" >&2; exit 1 ;;
esac
printf '%s' "$URL" | gh secret set OPS_ALERT_WEBHOOK_URL
unset URL
echo "secret OPS_ALERT_WEBHOOK_URL set on $(gh repo view --json nameWithOwner --jq .nameWithOwner)"
gh workflow run offhost-uptime.yml -f test_alert=true
echo "test run started: one message, 'dazl test alert from the off-server check', should arrive within a minute or two"
echo "watch it: gh run list --workflow offhost-uptime.yml --limit 3"
