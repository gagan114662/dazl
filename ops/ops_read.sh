#!/bin/bash
# Read-only ops-door client. NEVER-AGAIN.md #13: a lane WIPED the staging trial allowlist by calling the ops door's
# env-write endpoint during a read-only-intended probe. Lanes, builders and agents read through the ops door with this
# script and nothing else; every env/setting change is the owner's, by hand, with the old value recorded first.
#
# usage: ops_read.sh <path-or-url> [extra curl args]
#   ops_read.sh '/env?env=staging'                     # keys only, never values
#   ops_read.sh '/db?env=staging&q=SELECT%201'
#   OPS_BASE=https://staging.dazl.ai/__ops ops_read.sh '/logs?env=staging'
# The token comes from OPS_TOKEN, or from the file named by OPS_TOKEN_FILE (default ~/.config/hermes/dazl_ops_token).
# It is never printed. A refusal exits 3 and makes no request at all.
set -uo pipefail

OPS_BASE=${OPS_BASE:-https://staging.dazl.ai/__ops}
OPS_TOKEN_FILE=${OPS_TOKEN_FILE:-$HOME/.config/hermes/dazl_ops_token}

refuse() {
  echo "REFUSED: $1" >&2
  echo "ops_read.sh is read-only (NEVER-AGAIN.md #13: no ops-door env writes from lanes)." >&2
  echo "Config changes to staging or prod env are the owner's, by hand, with the current value recorded first." >&2
  exit 3
}

[ $# -ge 1 ] || refuse "no path given"

target=$1
shift

# 1. GET only. Anything that would change the method or send a body is refused before a request is made. Every ops-door
#    write (env/set, mail/enable, deploy, rollback, restart) is non-GET, so this check alone stops all of them.
for arg in "$@"; do
  case $arg in
    -X|-X*|--request|--request=*)
      refuse "ops_read.sh only makes GET requests (saw $arg)" ;;
    -d|-d*|--data|--data=*|--data-*|--json|--json=*|-F|-F*|--form|--form-*|-T|-T*|--upload-file|--upload-file=*)
      refuse "ops_read.sh sends no request body (saw $arg)" ;;
    -I|--head)
      refuse "ops_read.sh only makes GET requests (saw $arg)" ;;
  esac
done

# 2. Refuse write endpoints by PATH as well, whatever the method, so dropping the method check alone cannot turn this
#    into a write client. The query string is not searched for verbs (a read-only SQL query may contain "offset").
lower=$(printf '%s' "$target" | tr '[:upper:]' '[:lower:]')
path_only=${lower%%\?*}
query_only=""
case $lower in *\?*) query_only=${lower#*\?} ;; esac

if printf '%s' "$path_only" | grep -Eq '(^|/)(env|config|settings?|secrets?|flags?|keys?)/(set|unset|put|patch|post|update|write|delete|remove|add|clear|reset)(/|$)'; then
  refuse "$target writes an env value or setting"
fi
case $path_only in
  *mail/enable*|*mail/disable*)
    refuse "$target rewrites the env file (it enables system mail by writing a key)" ;;
  */deploy/*|*/deploy|*rollback*|*/restart/*|*/restart|*stop-port*|*/migrate*|*/seed*)
    refuse "$target changes a running environment; deploys, restarts and migrations are not reads" ;;
esac
# an env/setting path carrying a write parameter (the ops door removes a key with &unset=1)
case $query_only in
  *unset=*|*"&set="*|set=*|*newvalue=*|*new_value=*)
    refuse "$target carries a write parameter" ;;
esac

case $target in
  https://*|http://*) url=$target ;;
  /*)                 url="${OPS_BASE}${target}" ;;
  *)                  refuse "path must start with / or be a full ops-door URL" ;;
esac

if [ -n "${OPS_TOKEN:-}" ]; then
  token=$OPS_TOKEN
elif [ -r "$OPS_TOKEN_FILE" ]; then
  token=$(tr -d '[:space:]' < "$OPS_TOKEN_FILE")
else
  echo "no ops token: set OPS_TOKEN or put it in $OPS_TOKEN_FILE" >&2
  exit 4
fi
[ -n "$token" ] || { echo "ops token is empty" >&2; exit 4; }

# -G keeps it a GET even if a later edit passes data. There is no -X anywhere in this file.
exec curl -sS -G -m 120 -H "Authorization: Bearer $token" "$url" "$@"
