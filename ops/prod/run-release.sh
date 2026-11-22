#!/usr/bin/env bash
# ExecStart of dazl-prod@<port>.service (runs as the app user, never root).
# DAZL_RELEASE comes from /etc/dazl-prod/ports/<port>.conf (written by deploy-prod.sh, read by systemd).
# The release's own env file (.release.env, shell-quoted KEY=value data written by deploy-prod.sh as the app user)
# is loaded, then `next start` is exec'd directly (no npm/npx wrapper: one process, ~40 MB less, signals go to next).
set -euo pipefail
PORT_ARG=${1:?usage: run-release.sh <port>}
[[ $PORT_ARG =~ ^31[0-9]{2}$ ]] || { echo "run-release: bad port $PORT_ARG" >&2; exit 2; }
[[ ${DAZL_RELEASE:-} =~ ^/[A-Za-z0-9._/-]+/dazl-[0-9a-f]{8}-prod$ ]] || { echo "run-release: DAZL_RELEASE '${DAZL_RELEASE:-}' is not a release dir" >&2; exit 2; }
[ -f "$DAZL_RELEASE/.release.env" ] && [ -x "$DAZL_RELEASE/web/node_modules/.bin/next" ] || { echo "run-release: $DAZL_RELEASE is incomplete" >&2; exit 2; }
set -a
. "$DAZL_RELEASE/.release.env"
set +a
export PORT=$PORT_ARG
# #1463: libuv's pool (fs, async zlib, dns.lookup) is 4 threads by default. A scan's slow lookups filled it and every
# /_next/static chunk read queued behind them, so /app never hydrated until the scan ended. Read once, at process start,
# so it must be set here, before exec (setting it from app code is too late). An explicit value from the env wins.
export UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE:-32}
cd "$DAZL_RELEASE/web"
exec ./node_modules/.bin/next start -p "$PORT_ARG"
