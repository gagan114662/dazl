#!/usr/bin/env bash
# #1116: the sign-up and sign-in forms hydrate (React attached, submit handler present) on the deployed site.
set -euo pipefail
node "$(dirname "$0")/../../prod/check-hydration.mjs" "$BASE_URL"
