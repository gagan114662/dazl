#!/bin/bash
# Puts a NEW Anthropic key in place of an exposed one on the box (issue #1617). Run from the owner's Mac, once per
# environment, after the new key has been created on platform.claude.com and before the old one is revoked.
#
#   DAZL_SSH_HOST=<ssh alias or user@host of the box> ops/owner/swap-anthropic-key.sh staging
#   DAZL_SSH_HOST=<ssh alias or user@host of the box> ops/owner/swap-anthropic-key.sh production
#
# It asks for the new key with a hidden prompt (nothing shows while you paste). The key travels inside the ssh
# connection: it is never printed, never on a command line and never written on the Mac. Only the last 4 characters of
# the old and new key are shown.
#
# staging:    replaces DAZL_TRIAL_ANTHROPIC_KEY in the staging env file, restarts the staging app and waits for its
#             health answer.
# production: replaces DAZL_TRIAL_ANTHROPIC_KEY, and ANTHROPIC_API_KEY when it holds the same old key, in the run env
#             the deploy reads. It does NOT restart production: the running app keeps the old key until the next
#             deploy, so deploy the live commit again (the script prints it) and only then revoke the old key.
#
# The file before the change is kept next to it as <file>.before-key-swap-<UTC time> (same owner, same mode).
# To undo: copy that file back and restart staging, or deploy production again.
set -euo pipefail
: "${DAZL_SSH_HOST:?set DAZL_SSH_HOST to the ssh alias or user@host of the box}"
TARGET=${1:-}
case "$TARGET" in staging|production) ;; *) echo "usage: DAZL_SSH_HOST=<box> ops/owner/swap-anthropic-key.sh staging|production" >&2; exit 2 ;; esac
[ $# -eq 1 ] || { echo "usage: DAZL_SSH_HOST=<box> ops/owner/swap-anthropic-key.sh staging|production" >&2; exit 2; }
IFS= read -rs -p "Paste the NEW Anthropic key for $TARGET, then Enter (it will not show): " NEW_KEY; echo
[[ $NEW_KEY =~ ^sk-ant-[A-Za-z0-9_-]{40,}$ ]] || { echo "FAIL: that is not an Anthropic key (it must start sk-ant- and have no spaces); nothing changed" >&2; exit 1; }
echo "new key ends ...${NEW_KEY: -4}"
# The part that runs on the box reads the key as its first line of input; printf is part of the shell, so the key is
# never an argument of a program.
{ printf '%s\n' 'IFS= read -r NEW_KEY' "$NEW_KEY"; cat <<'EOF'; } | ssh -o ConnectTimeout=10 -o BatchMode=yes -- "$DAZL_SSH_HOST" "sudo bash -s -- $TARGET" 2>&1 | sed -E 's#sk-ant-[A-Za-z0-9_-]+#<key>#g'
set -u
TARGET=$1
export NEW_KEY
case "$TARGET" in
  staging) FILE=/etc/dazl-staging/env ;;
  production) FILE=${PROD_RUN_ENV:-/home/ubuntu/dazl-pr16-run.env} ;;
  *) echo "FAIL: unknown target; nothing changed"; exit 1 ;;
esac
[ -f "$FILE" ] || { echo "FAIL: $FILE is not there; nothing changed"; exit 1; }
python3 - "$FILE" <<'PY' || exit 1
import os, re, shutil, sys, time
path = sys.argv[1]
new = os.environ['NEW_KEY']
line_re = re.compile(r'^(\s*(?:export\s+)?)(DAZL_TRIAL_ANTHROPIC_KEY|ANTHROPIC_API_KEY)=(["\']?)([^"\'\r\n]*)(["\']?)(\r?\n?)$')
lines = open(path).read().splitlines(keepends=True)
found = {}
for i, line in enumerate(lines):
    m = line_re.match(line)
    if m:
        if m.group(2) in found:
            sys.exit('FAIL: %s is set twice in %s; nothing changed' % (m.group(2), path))
        found[m.group(2)] = (i, m)
if 'DAZL_TRIAL_ANTHROPIC_KEY' not in found:
    sys.exit('FAIL: %s has no DAZL_TRIAL_ANTHROPIC_KEY line; nothing changed' % path)
old = found['DAZL_TRIAL_ANTHROPIC_KEY'][1].group(4)
if old == new:
    sys.exit('FAIL: that key is already the one in %s; nothing changed' % path)
if not old:
    sys.exit('FAIL: DAZL_TRIAL_ANTHROPIC_KEY is empty in %s; nothing changed' % path)
# ANTHROPIC_API_KEY is replaced only when it holds the same old key
todo = [name for name in ('DAZL_TRIAL_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY') if name in found and found[name][1].group(4) == old]
for name in found:
    if name not in todo:
        print('%s holds a different key (ends ...%s): left as it is' % (name, found[name][1].group(4)[-4:]))
st = os.stat(path)
backup = '%s.before-key-swap-%s' % (path, time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
shutil.copy2(path, backup)
os.chown(backup, st.st_uid, st.st_gid)
for name in todo:
    i, m = found[name]
    lines[i] = '%s%s=%s%s%s%s' % (m.group(1), name, m.group(3), new, m.group(5), m.group(6))
tmp = path + '.key-swap.tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(''.join(lines))
os.chown(tmp, st.st_uid, st.st_gid)
os.chmod(tmp, st.st_mode & 0o7777)
os.replace(tmp, path)
print('file before the change kept as: %s' % backup)
for name in todo:
    print('%s: ...%s -> ...%s' % (name, old[-4:], new[-4:]))
PY
unset NEW_KEY
commit_of() {
  { curl -s --connect-timeout 2 --max-time 4 "http://127.0.0.1:$1/api/health" 2>/dev/null || true; } | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("commit") or "")
except Exception:
    print("")'
}
if [ "$TARGET" = staging ]; then
  systemctl restart dazl-staging.service || { echo "FAIL: staging did not restart; the key file IS changed"; exit 1; }
  if systemctl is-active --quiet dazl-staging-worker.service; then systemctl restart dazl-staging-worker.service || true; fi
  C=
  for _ in $(seq 1 45); do sleep 2; C=$(commit_of 3200); [ -z "$C" ] || break; done
  [ -n "$C" ] || { echo "FAIL: staging does not answer /api/health 90 seconds after the restart; the key file IS changed"; exit 1; }
  echo "staging restarted and healthy on commit $C"
  echo "DONE for staging. Next: one trial search on staging, then revoke the old key."
else
  LIVE=
  for p in 3104 3105; do [ "$(systemctl is-enabled "dazl-prod@$p.service" 2>/dev/null || true)" = enabled ] && LIVE=$p; done
  C=; [ -z "$LIVE" ] || C=$(commit_of "$LIVE")
  echo "production was NOT restarted: the running app still uses the old key."
  echo "Next: deploy the live commit again (${C:-read it from the health page}) with the prod-deploy workflow, run one trial search, then revoke the old key."
fi
EOF
