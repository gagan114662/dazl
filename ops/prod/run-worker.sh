#!/usr/bin/env bash
# #1463: ExecStart of dazl-prod-worker@<port>.service (runs as the app user, never root). The scan worker beside the
# release that serves <port>: same DAZL_RELEASE (/etc/dazl-prod/ports/<port>.conf, written by deploy-prod.sh), same
# .release.env, same database, no port. It takes scans from the shared work queue (DAZL_SCAN_SHARED_QUEUE=1, written
# into the release env by deploy-prod.sh only when PROD_SCAN_WORKER=1); without that flag it idles and says so.
# lib/scan/worker.ts sets this process's SCAN_MAX_CONCURRENT from SCAN_WORKER_CONCURRENCY (default 1), so the app's
# SCAN_MAX_CONCURRENT=0 (no in-process scans) never reaches the worker.
set -euo pipefail
PORT_ARG=${1:?usage: run-worker.sh <port>}
[[ $PORT_ARG =~ ^31[0-9]{2}$ ]] || { echo "run-worker: bad port $PORT_ARG" >&2; exit 2; }
[[ ${DAZL_RELEASE:-} =~ ^/[A-Za-z0-9._/-]+/dazl-[0-9a-f]{8}-prod$ ]] || { echo "run-worker: DAZL_RELEASE '${DAZL_RELEASE:-}' is not a release dir" >&2; exit 2; }
[ -f "$DAZL_RELEASE/.release.env" ] && [ -f "$DAZL_RELEASE/web/scripts/scan-worker.mts" ] || { echo "run-worker: $DAZL_RELEASE is incomplete" >&2; exit 2; }
set -a
. "$DAZL_RELEASE/.release.env"
set +a
unset PORT
cd "$DAZL_RELEASE/web"
exec /usr/bin/node --experimental-strip-types --no-warnings --max-old-space-size=256 scripts/scan-worker.mts
