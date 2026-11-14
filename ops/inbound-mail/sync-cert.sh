#!/usr/bin/env bash
# Run as root (dazl-inbound-mail-cert.service). Copies the certificate Caddy holds for the mail host into
# /etc/dazl-inbound-mail/tls (root:dazl-mail, key 0640) and restarts the receiver only when the certificate changed.
# No certificate yet (DNS for the mail host does not point here, or Caddy has no site for it) = nothing to do: the
# receiver then runs without STARTTLS.
set -euo pipefail
HOST=${MAIL_TLS_HOST:-mail.dazl.ai}
CADDY_CERTS=${CADDY_CERTS:-/var/lib/caddy/.local/share/caddy/certificates}
DEST=${MAIL_TLS_DEST:-/etc/dazl-inbound-mail/tls}
GROUP=${MAIL_GROUP:-dazl-mail}

# newest first: Caddy keeps one directory per issuer, and an old issuer's directory can hold a stale certificate
crt=$(find "$CADDY_CERTS" -type f -name "$HOST.crt" -path "*/$HOST/*" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2- || true)
key=${crt%.crt}.key
if [ -z "$crt" ] || [ ! -s "$key" ]; then
  echo "sync-cert: no Caddy certificate for $HOST yet; receiver stays without STARTTLS"
  exit 0
fi
if [ -s "$DEST/fullchain.pem" ] && cmp -s "$crt" "$DEST/fullchain.pem" && cmp -s "$key" "$DEST/privkey.pem"; then
  echo "sync-cert: certificate for $HOST unchanged"
  exit 0
fi
install -d -m 0750 -o root -g "$GROUP" "$DEST"
install -m 0640 -o root -g "$GROUP" "$crt" "$DEST/fullchain.pem.new"
install -m 0640 -o root -g "$GROUP" "$key" "$DEST/privkey.pem.new"
mv -f "$DEST/fullchain.pem.new" "$DEST/fullchain.pem"
mv -f "$DEST/privkey.pem.new" "$DEST/privkey.pem"
echo "sync-cert: installed the certificate for $HOST"
if [ "${MAIL_NO_RESTART:-0}" != 1 ] && systemctl is-active --quiet dazl-inbound-mail.service; then
  systemctl restart dazl-inbound-mail.service
  echo "sync-cert: receiver restarted with the new certificate"
fi
