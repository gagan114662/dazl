#!/bin/bash
# Records the box's memory once a second WHILE a production deploy runs (issue #1084, criterion 4: the peak during a
# deploy stays under 300 MB above the level before it). Read-only: it installs nothing and changes nothing.
# Run from the owner's Mac.
#
#   DAZL_SSH_HOST=<ssh alias or user@host of the box> ops/owner/sample-deploy-memory.sh [seconds, default 300]
#
# Start it FIRST, then start the deploy (the prod-deploy workflow) within about 20 seconds. It takes the level before
# the deploy from its first 10 samples, then watches until the time is up. A deploy takes about a minute, so the
# default 5 minutes leaves room for a late start. It ends by itself and prints one PASS or FAIL line.
# "Used" is the kernel's own figure: total memory minus MemAvailable (/proc/meminfo).
set -euo pipefail
: "${DAZL_SSH_HOST:?set DAZL_SSH_HOST to the ssh alias or user@host of the box}"
SECS=${1:-300}
[[ $SECS =~ ^[1-9][0-9]{1,3}$ ]] && [ $# -le 1 ] || { echo "usage: DAZL_SSH_HOST=<box> ops/owner/sample-deploy-memory.sh [seconds, 30 to 9999]" >&2; exit 2; }
[ "$SECS" -ge 30 ] || { echo "usage: DAZL_SSH_HOST=<box> ops/owner/sample-deploy-memory.sh [seconds, 30 to 9999]" >&2; exit 2; }
# DAZL_SSH_OPTS: extra ssh options, for an alias whose address needs overriding
# shellcheck disable=SC2086
ssh -o ConnectTimeout=10 -o BatchMode=yes ${DAZL_SSH_OPTS:-} -- "$DAZL_SSH_HOST" "bash -s -- $SECS" <<'EOF'
set -u
SECS=$1
LIMIT=300   # MB above the level before the deploy that the issue allows
used_mb() { awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {printf "%d\n", (t-a)/1024}' /proc/meminfo; }
swap_mb() { awk '/^SwapTotal:/ {t=$2} /^SwapFree:/ {f=$2} END {printf "%d\n", (t-f)/1024}' /proc/meminfo; }
# one word per active production port: <port>:<process id>. The old release stays up after a deploy (for rollback),
# so a deploy shows as a port getting a NEW process, not as a second port appearing.
live() { for p in 3104 3105; do [ "$(systemctl is-active "dazl-prod@$p.service" 2>/dev/null)" = active ] && printf '%s:%s ' "$p" "$(systemctl show -p MainPID --value "dazl-prod@$p.service")"; done; }
commits() { for w in $(live); do printf '%s=%s ' "${w%%:*}" "$(commit "${w%%:*}" | cut -c1-8)"; done; }
commit() { { curl -s --connect-timeout 2 --max-time 4 "http://127.0.0.1:$1/api/health" 2>/dev/null || true; } | sed -n 's/.*"commit" *: *"\([0-9a-f]\{40\}\)".*/\1/p'; }
START_PORTS=$(live)
START_COMMITS=$(commits)
echo "start $(date -u +%H:%M:%SZ): total $(awk '/^MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo) MB, production port:process ${START_PORTS:-none}, commit ${START_COMMITS:-none}"
base_sum=0; n=0
while [ $n -lt 10 ]; do base_sum=$(( base_sum + $(used_mb) )); n=$(( n + 1 )); sleep 1; done
BASE=$(( base_sum / 10 ))
echo "level before the deploy (10 second average): ${BASE} MB used, swap ${SWAP0:=$(swap_mb)} MB"
echo "watching for $SECS seconds: start the deploy now"
PEAK=$BASE; PEAK_AT=; PEAK_SWAP=$SWAP0; T0=$(date +%s); LAST_PORTS=$START_PORTS; SEEN=0
while [ $(( $(date +%s) - T0 )) -lt "$SECS" ]; do
  u=$(used_mb); s=$(swap_mb)
  if [ "$u" -gt "$PEAK" ]; then PEAK=$u; PEAK_AT=$(date -u +%H:%M:%SZ); fi
  [ "$s" -le "$PEAK_SWAP" ] || PEAK_SWAP=$s
  now_ports=$(live)
  if [ "$now_ports" != "$LAST_PORTS" ]; then echo "$(date -u +%H:%M:%SZ) production port:process now ${now_ports:-none} (used ${u} MB)"; LAST_PORTS=$now_ports; SEEN=1; fi
  sleep 1
done
END_COMMITS=$(commits)
DELTA=$(( PEAK - BASE ))
echo "end $(date -u +%H:%M:%SZ): used $(used_mb) MB, production port:process $(live), commit ${END_COMMITS:-none}"
echo "peak: ${PEAK} MB used${PEAK_AT:+ at $PEAK_AT}, ${DELTA} MB above the level before; swap went from ${SWAP0} MB to at most ${PEAK_SWAP} MB"
echo "out-of-memory kills in the kernel log during the watch: $(journalctl -k --since "-$(( SECS + 15 ))s" --no-pager 2>/dev/null | grep -ci 'out of memory' || true)"
if [ "$SEEN" != 1 ]; then echo "NO DEPLOY SEEN: no production port got a new process during the watch, so this run proves nothing (peak was ${DELTA} MB above the level before)"; exit 1; fi
if [ "$DELTA" -lt "$LIMIT" ]; then echo "PASS: the peak during the deploy was ${DELTA} MB above the level before (limit ${LIMIT} MB)"
else echo "FAIL: the peak during the deploy was ${DELTA} MB above the level before (limit ${LIMIT} MB)"; exit 1; fi
EOF
