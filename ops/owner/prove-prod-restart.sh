#!/bin/bash
# Shows how production is supervised on the box (issue #1083) and, with --kill, proves it restarts by itself.
# Run from the owner's Mac.
#
#   DAZL_SSH_HOST=<ssh alias or user@host of the box> ops/owner/prove-prod-restart.sh          # read-only report
#   DAZL_SSH_HOST=<ssh alias or user@host of the box> ops/owner/prove-prod-restart.sh --kill   # the kill test
#
# Without --kill it changes nothing: it prints the live unit, the user it runs as, its restart and memory settings,
# whether it starts at boot, where it listens, and when the box booted next to when the unit started (run it after a
# reboot to show production came back with no one logging in).
#
# With --kill it sends SIGKILL to the live production process ONCE. dazl.ai answers 502 until systemd has started it
# again (expected: under 30 seconds). It then checks that the same commit answers from a new process, that the restart
# counter went up by one, and that the process is not root. Nothing is installed, edited or stopped, and no database
# is touched. Pick a quiet moment: a search that is running when the process dies is interrupted.
set -euo pipefail
: "${DAZL_SSH_HOST:?set DAZL_SSH_HOST to the ssh alias or user@host of the box}"
MODE=report
case "${1:-}" in
  '') ;;
  --kill) MODE=kill ;;
  *) echo "usage: DAZL_SSH_HOST=<box> ops/owner/prove-prod-restart.sh [--kill]" >&2; exit 2 ;;
esac
[ $# -le 1 ] || { echo "usage: DAZL_SSH_HOST=<box> ops/owner/prove-prod-restart.sh [--kill]" >&2; exit 2; }
ssh -o ConnectTimeout=10 -o BatchMode=yes -- "$DAZL_SSH_HOST" "sudo bash -s -- $MODE" <<'EOF' 2>&1 | sed -E 's#https?://[^ ]+#<url>#g'
set -u
MODE=$1
LIMIT=30   # seconds the issue allows between the kill and a healthy answer
fail() { echo "FAIL: $*"; exit 1; }
# the commit the app on port $1 reports, or nothing
commit_of() {
  { curl -s --connect-timeout 2 --max-time 4 "http://127.0.0.1:$1/api/health" 2>/dev/null || true; } | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("commit") or "")
except Exception:
    print("")'
}
prop() { systemctl show -p "$2" --value "dazl-prod@$1.service"; }

# the live instance is the one the deploy enabled at boot; the other port is the spare
LIVE=
for p in 3104 3105; do
  en=$(systemctl is-enabled "dazl-prod@$p.service" 2>/dev/null || true)
  ac=$(systemctl is-active "dazl-prod@$p.service" 2>/dev/null || true)
  echo "dazl-prod@$p: active=$ac enabled=$en"
  if [ "$en" = enabled ] && [ "$ac" = active ]; then
    [ -z "$LIVE" ] || fail "both ports are active and enabled (a deploy may be running); nothing changed"
    LIVE=$p
  fi
done
[ -n "$LIVE" ] || fail "no dazl-prod@<port> unit is both active and enabled at boot; nothing changed"
PID=$(prop "$LIVE" MainPID)
RUN_USER=$(ps -o user= -p "$PID" 2>/dev/null | tr -d ' ')
COMMIT=$(commit_of "$LIVE")
echo "live unit: dazl-prod@$LIVE.service, process $PID, user ${RUN_USER:-?}"
echo "settings: Restart=$(prop "$LIVE" Restart) RestartUSec=$(prop "$LIVE" RestartUSec) MemoryMax=$(prop "$LIVE" MemoryMax) NoNewPrivileges=$(prop "$LIVE" NoNewPrivileges) ProtectSystem=$(prop "$LIVE" ProtectSystem)"
echo "restarts so far: $(prop "$LIVE" NRestarts)"
echo "box booted: $(uptime -s)   unit started: $(prop "$LIVE" ActiveEnterTimestamp)"
echo "listens on: $(ss -ltnH "sport = :$LIVE" 2>/dev/null | awk '{print $4}' | tr '\n' ' ')"
echo "health commit: ${COMMIT:-none}"
REL=$(sed -n 's/^DAZL_RELEASE=//p' "/etc/dazl-prod/ports/$LIVE.conf" 2>/dev/null | head -1)
if [ -n "$REL" ] && [ -f "$REL/ops/prod/dazl-prod@.service" ]; then
  if cmp -s "$REL/ops/prod/dazl-prod@.service" /etc/systemd/system/dazl-prod@.service; then echo "installed unit file: same as the live release's copy"
  else echo "installed unit file: DIFFERS from the live release's copy (ops/prod/README.md, Supervised process)"; fi
fi
[ -n "$RUN_USER" ] && [ "$RUN_USER" != root ] || fail "the live process runs as '${RUN_USER:-unknown}'; it must not be root"
[[ $COMMIT =~ ^[0-9a-f]{40}$ ]] || fail "the live port does not answer /api/health with a commit; nothing changed"
if [ "$MODE" != kill ]; then echo "REPORT ONLY: nothing changed (add --kill for the restart test)"; exit 0; fi

BEFORE=$(prop "$LIVE" NRestarts)
echo "--- kill test: SIGKILL to dazl-prod@$LIVE.service at $(date -u +%H:%M:%SZ) ---"
systemctl kill -s KILL "dazl-prod@$LIVE.service" || fail "systemctl kill refused"
T0=$(date +%s); TOOK=; NEWPID=
while [ $(( $(date +%s) - T0 )) -lt 90 ]; do
  sleep 1
  NEWPID=$(prop "$LIVE" MainPID)
  if [ "$NEWPID" != 0 ] && [ "$NEWPID" != "$PID" ] && [ "$(commit_of "$LIVE")" = "$COMMIT" ]; then TOOK=$(( $(date +%s) - T0 )); break; fi
done
[ -n "$TOOK" ] || { journalctl -u "dazl-prod@$LIVE.service" -n 15 --no-pager -o cat; fail "no healthy answer 90 seconds after the kill: PRODUCTION MAY BE DOWN, run deploy-prod.sh --status on the box now"; }
AFTER=$(prop "$LIVE" NRestarts)
NEW_USER=$(ps -o user= -p "$NEWPID" 2>/dev/null | tr -d ' ')
echo "healthy again after ${TOOK}s: process $NEWPID, user ${NEW_USER:-?}, same commit $COMMIT"
echo "restarts: $BEFORE -> $AFTER"
bad=0
[ "$TOOK" -le "$LIMIT" ] || { echo "FAIL: took longer than ${LIMIT}s"; bad=1; }
[ "$AFTER" = $(( BEFORE + 1 )) ] || { echo "FAIL: the restart counter did not go up by exactly one"; bad=1; }
[ -n "$NEW_USER" ] && [ "$NEW_USER" != root ] || { echo "FAIL: the new process runs as '${NEW_USER:-unknown}'"; bad=1; }
[ $bad = 0 ] || exit 1
echo "PASS: systemd restarted production by itself in ${TOOK}s"
EOF
