#!/usr/bin/env bash
# #1393: the switched-off second lead engine is deleted from the release that is live.
set -euo pipefail
live=$(curl -fsS --max-time 30 "$BASE_URL/api/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.commit||j.sha||j.build?.commit||"")})')
[ "$live" = "$SHA" ] || { echo "live commit is ${live:-unknown}, expected $SHA"; exit 1; }
if [ -d web/lib/research ] || [ -n "$(git ls-tree -r --name-only "$SHA" -- web/lib/research 2>/dev/null | head -1)" ]; then echo "web/lib/research is still in $SHA"; exit 1; fi
echo "live commit $SHA carries no web/lib/research"
