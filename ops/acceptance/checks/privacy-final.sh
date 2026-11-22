#!/usr/bin/env bash
# #1428: the published privacy policy is the finished one: no draft banner, no open placeholder, and it covers the dazl Connect extension.
set -euo pipefail
page=$(curl -fsS --max-time 30 "$BASE_URL/privacy")
if grep -q 'DRAFT - not yet approved' <<<"$page"; then echo "the privacy page still shows the draft banner"; exit 1; fi
if grep -Eq '\[(NEEDS|DATE|SYSTEM)[^]]*\]' <<<"$page"; then echo "the privacy page still has an open placeholder"; exit 1; fi
grep -q 'dazl Connect browser extension' <<<"$page" || { echo "the privacy page does not cover the extension"; exit 1; }
echo "privacy page: final text, covers the extension"
