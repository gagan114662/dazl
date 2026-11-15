#!/usr/bin/env bash
# Install (or update) the dazl inbound mail receiver on the box. Run as root from a copy of ops/inbound-mail:
#   sudo bash install.sh [--mail-env-from /etc/dazl-staging/env]
# Copy it to a directory only you can write (mktemp -d), not a fixed /tmp path: this script runs as root.
# It installs files, the service user and the units, and stops there: it never starts the receiver, never touches DNS,
# the security group, Caddy or the app. The receiver stays off until the switch file exists (README.md, "Switch").
# Nothing is built here: the receiver is one Python file and its one dependency is Ubuntu's python3-aiosmtpd package.
# --mail-env-from FILE copies SYSTEM_MAIL_SMTP_URL and SYSTEM_MAIL_FROM from an existing env file without printing them.
set -euo pipefail
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MAIL_ENV_FROM=
while [ $# -gt 0 ]; do
  case $1 in
    --mail-env-from) MAIL_ENV_FROM=${2:?--mail-env-from needs a file}; shift 2 ;;
    *) echo "install: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "install: run as root" >&2; exit 2; }

# /usr/bin/python3 is the interpreter the unit runs
/usr/bin/python3 -c 'import aiosmtpd' 2>/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-aiosmtpd
/usr/bin/python3 -c 'import aiosmtpd'

id dazl-mail >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dazl-mail
install -d -m 0755 -o root -g root /opt/dazl-inbound-mail /etc/dazl-inbound-mail
install -d -m 0700 -o dazl-mail -g dazl-mail /var/spool/dazl-inbound
install -m 0755 -o root -g root "$SRC/receiver.py" "$SRC/sync-cert.sh" /opt/dazl-inbound-mail/
[ -f /etc/dazl-inbound-mail/config.json ] || install -m 0644 -o root -g root "$SRC/config.example.json" /etc/dazl-inbound-mail/config.json

ENV=/etc/dazl-inbound-mail/env
if [ ! -f "$ENV" ]; then
  ( umask 077; printf '%s\n' '# dazl inbound mail secrets (root only). Never print this file.' \
      '# INBOUND_BACKEND_KEY = the key the app checks in x-dazl-key on /internal/admin/inbound-email.' \
      'INBOUND_BACKEND_KEY=' 'SYSTEM_MAIL_SMTP_URL=' 'SYSTEM_MAIL_FROM=' > "$ENV" )
fi
chown root:root "$ENV"; chmod 0600 "$ENV"
if [ -n "$MAIL_ENV_FROM" ]; then
  [ -r "$MAIL_ENV_FROM" ] || { echo "install: cannot read $MAIL_ENV_FROM" >&2; exit 2; }
  for k in SYSTEM_MAIL_SMTP_URL SYSTEM_MAIL_FROM; do
    line=$(grep -m1 "^$k=" "$MAIL_ENV_FROM" || true)
    [ -n "$line" ] || { echo "install: $k is not in $MAIL_ENV_FROM" >&2; exit 2; }
    tmp=$(mktemp "$ENV.XXXXXX")
    { grep -v "^$k=" "$ENV" || true; printf '%s\n' "$line"; } > "$tmp"
    chown root:root "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$ENV"
    echo "install: $k copied (value not shown)"
  done
fi

install -m 0644 -o root -g root "$SRC/dazl-inbound-mail.service" "$SRC/dazl-inbound-mail-cert.service" \
  "$SRC/dazl-inbound-mail-cert.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable dazl-inbound-mail.service dazl-inbound-mail-cert.timer >/dev/null 2>&1
systemctl start dazl-inbound-mail-cert.timer

DAZL_INBOUND_CONFIG=/etc/dazl-inbound-mail/config.json /usr/bin/python3 /opt/dazl-inbound-mail/receiver.py check-config >/dev/null
if [ -e /etc/dazl-inbound-mail/enabled ]; then
  echo "install: files updated; the switch is ON. Restart to pick them up: systemctl restart dazl-inbound-mail"
else
  echo "install: done; the switch is OFF (touch /etc/dazl-inbound-mail/enabled && systemctl start dazl-inbound-mail)"
fi
