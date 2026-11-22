#!/usr/bin/env bash
# #1122 (dazl Connect 0.2): the extension's task routes are live and refuse a caller with no device token. A 404 means the
# routes are not deployed; anything but a refusal means they are open.
set -euo pipefail
for path in /api/tasks/next /api/tasks/complete; do
  method=GET; [ "$path" = /api/tasks/complete ] && method=POST
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X "$method" -H 'content-type: application/json' -d '{}' "$BASE_URL$path")
  [ "$code" = 401 ] || { echo "$method $path answered $code, expected 401"; exit 1; }
done
echo "task routes are live and refuse a caller with no token"
