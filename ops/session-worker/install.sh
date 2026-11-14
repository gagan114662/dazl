#!/usr/bin/env bash
# Install or update the dazl session worker for one environment (#1037, F-go step 1). Run as root on the box:
#
#   install.sh <staging|prod> <repo checkout> <commit sha> [--token-from <the app's env file>]
#
# 1. a system user `dazl-session` (no home, no shell) when it does not exist;
# 2. session-worker/ at exactly <commit>, by `git archive` from the checkout, into /opt/dazl-session-worker/releases/<commit>
#    (root-owned, read-only to the worker), and the instance's symlink /opt/dazl-session-worker/<env> pointed at it;
# 3. the instance's env file /etc/dazl-session-worker/<env>.env when it does not exist: PORT (staging 8788, prod 8787),
#    HOST=127.0.0.1 and ADVANCED_WORKER_TOKEN: the app's own value when --token-from names the app's env file (so the app needs
#    no new token), else a new random one; mode 0640 root:dazl-session. An existing file is kept as it is,
#    so re-running never rotates the token under a running app;
# 4. the unit template, then `systemctl enable` + `restart` of dazl-session-worker@<env>, and a health check on 127.0.0.1;
# 5. /etc/dazl-session-worker/<env>.app-env (mode 0600 root): the two lines the APP's env needs (ADVANCED_WORKER_URL and the
#    same ADVANCED_WORKER_TOKEN). The token is never printed.
#
# Nothing here touches the app, its env file, its database or Caddy. Every path can be moved for tests (SW_* variables below).
set -euo pipefail

ENV_NAME=${1:-}; REPO=${2:-}; SHA=${3:-}; TOKEN_FROM=
if [ "${4:-}" = --token-from ]; then TOKEN_FROM=${5:-}; [ -n "$TOKEN_FROM" ] || { echo "install.sh: --token-from needs a file" >&2; exit 1; }; elif [ -n "${4:-}" ]; then echo "install.sh: unknown argument ${4}" >&2; exit 1; fi
ROOT=${SW_ROOT:-/opt/dazl-session-worker}
ETC=${SW_ETC:-/etc/dazl-session-worker}
UNIT_DIR=${SW_UNIT_DIR:-/etc/systemd/system}
SYSTEMCTL=${SW_SYSTEMCTL:-systemctl}
USER_NAME=${SW_USER:-dazl-session}
HEALTH_TRIES=${SW_HEALTH_TRIES:-20}
HERE=$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

fail() { echo "install.sh: $*; nothing more done" >&2; exit 1; }

case "$ENV_NAME" in staging) PORT=8788 ;; prod) PORT=8787 ;; *) fail "usage: install.sh <staging|prod> <repo checkout> <commit sha>" ;; esac
PORT=${SW_PORT:-$PORT}   # tests only: a free port
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || fail "the commit must be a full 40-character sha, got '${SHA}'"
[ -d "$REPO" ] && git -C "$REPO" cat-file -e "$SHA^{commit}" 2>/dev/null || fail "$REPO has no commit $SHA"
git -C "$REPO" cat-file -e "$SHA:session-worker/src/server.ts" 2>/dev/null || fail "commit $SHA has no session-worker/src/server.ts"
[ "${SW_ALLOW_NONROOT:-}" = 1 ] || [ "$(id -u)" = 0 ] || fail "run as root"

# 1. the user
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  ${SW_USERADD:-useradd} --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group "$USER_NAME"
fi

# 2. the code, at exactly that commit
REL=$ROOT/releases/$SHA
if [ ! -f "$REL/session-worker/src/server.ts" ]; then
  mkdir -p "$ROOT/releases"
  tmp=$(mktemp -d "$ROOT/releases/.tmp.XXXXXX")
  git -C "$REPO" archive "$SHA" session-worker | tar -x -C "$tmp"
  chmod -R a+rX,go-w "$tmp"
  mv -T "$tmp" "$REL"
fi
ln -sfn "$REL/session-worker" "$ROOT/$ENV_NAME.next" && mv -T "$ROOT/$ENV_NAME.next" "$ROOT/$ENV_NAME"

# 3. the instance's env file (kept when it exists: the app holds the same token)
mkdir -p "$ETC"; chmod 0755 "$ETC"
ENVF=$ETC/$ENV_NAME.env
if [ ! -f "$ENVF" ]; then
  umask 077
  if [ -n "$TOKEN_FROM" ]; then
    # one KEY=value line, read as data (never sourced); surrounding single or double quotes are dropped
    tok=$(sed -n 's/^ADVANCED_WORKER_TOKEN=//p' "$TOKEN_FROM" 2>/dev/null | tail -1 | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/')
    [[ $tok =~ ^[A-Za-z0-9._~+/=-]{16,512}$ ]] || fail "$TOKEN_FROM has no usable ADVANCED_WORKER_TOKEN (16+ characters, no spaces or quotes)"
  else
    tok=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  fi
  printf 'PORT=%s\nHOST=127.0.0.1\nADVANCED_WORKER_TOKEN=%s\n' "$PORT" "$tok" > "$ENVF.tmp"
  mv -T "$ENVF.tmp" "$ENVF"
  unset tok
fi
${SW_CHOWN:-chown} "root:$USER_NAME" "$ENVF"; chmod 0640 "$ENVF"
PORT_NOW=$(sed -n 's/^PORT=//p' "$ENVF" | tail -1)
[[ $PORT_NOW =~ ^[0-9]+$ ]] || fail "$ENVF has no PORT"
grep -q '^HOST=127\.0\.0\.1$' "$ENVF" || fail "$ENVF must keep HOST=127.0.0.1 (the worker carries session cookies)"

# 4. the unit, then the service
install -m 0644 "$HERE/dazl-session-worker@.service" "$UNIT_DIR/dazl-session-worker@.service"
$SYSTEMCTL daemon-reload
$SYSTEMCTL enable "dazl-session-worker@$ENV_NAME.service" >/dev/null
$SYSTEMCTL restart "dazl-session-worker@$ENV_NAME.service"
ok=0
for _ in $(seq 1 "$HEALTH_TRIES"); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT_NOW/health" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
  sleep 0.5
done
[ "$ok" = 1 ] || fail "dazl-session-worker@$ENV_NAME did not answer on 127.0.0.1:$PORT_NOW/health (journalctl -u dazl-session-worker@$ENV_NAME)"

# 5. the app's two lines, for the operator to add to the app's env (never printed here)
( umask 077; { echo "ADVANCED_WORKER_URL=http://127.0.0.1:$PORT_NOW"; grep '^ADVANCED_WORKER_TOKEN=' "$ENVF"; } > "$ETC/$ENV_NAME.app-env" )
chmod 0600 "$ETC/$ENV_NAME.app-env"
echo "dazl-session-worker@$ENV_NAME: session-worker at $SHA, healthy on 127.0.0.1:$PORT_NOW"
echo "the app's env needs the two lines in $ETC/$ENV_NAME.app-env (ADVANCED_WORKER_URL, ADVANCED_WORKER_TOKEN), then an app restart"
