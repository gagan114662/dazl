# Inbound mail receiver for dazl.ai (AWS only)

Refs #1111. Replaces Cloudflare Email Routing: a small SMTP server on the dazl EC2 box that takes mail for `@dazl.ai`.
SES receiving is not an option (the org policy keeps the account in us-east-2, which has no SES receiving).

- `receiver.py`: the server (Python standard library + `aiosmtpd`, Ubuntu's `python3-aiosmtpd`).
- `dazl-inbound-mail.service`: runs it on port 25 as the unprivileged user `dazl-mail`; its only capability is
  `CAP_NET_BIND_SERVICE`.
- `config.example.json`: the address routing table and limits (installed as `/etc/dazl-inbound-mail/config.json`).
- `install.sh`: installs everything on the box, **switched off**.
- `sync-cert.sh` + `dazl-inbound-mail-cert.{service,timer}`: copies Caddy's certificate for `mail.dazl.ai` so the receiver
  can offer STARTTLS.
- `test_receiver.py`: the tests (run by `.github/workflows/release-preflight.yml`).

## What it does with a message

It accepts mail only for the domains in `domains` (anything else: `550 5.7.1 Relaying denied`, so it is not an open
relay), at most 10 MB (`552`), one recipient per message (`452` for a second one: the sender sends it separately), with
per-IP limits on connections per minute, messages per minute and open connections (`421` / `451`).

Each recipient is looked up in `routes`; an address that is not listed uses `default_route`:

| route action | what happens |
| --- | --- |
| `backend` (`reply@dazl.ai`) | the app contract below |
| `forward` | the mail is wrapped and sent to the route's `to`, or to `fallback_forward` when it has none |
| `reject` | `550` with the route's `reason` |

### The app contract (the same one the Cloudflare Worker `dazl-frontdesk` used)

`POST {backend_url}` with `{from, to, raw: base64(full MIME)}`, headers `x-dazl-key: $INBOUND_BACKEND_KEY` and
`x-dazl-forwarded: 1`, a 90 s timeout, one retry after a network error or a 5xx (never after a timeout or a 4xx),
redirects not followed. The raw bytes are passed on untouched: the app's idempotency key is
sha256(envelope from + envelope to + raw), so a sender's retry gets the stored answer.

| the app answers | the sender gets | and |
| --- | --- | --- |
| `{"action":"accept"}` | `250` | |
| `{"action":"reject","reason"}` | `550` + the reason (control characters removed, 300 characters) | |
| `{"action":"forward","to"}` | `250` | the mail goes to `fallback_forward`, and only there: any other address the app names is refused (the fallback gets the mail; with no fallback, a polite `550`) |
| `{"action":"reply","from","to","raw"}` | `250` | the reply is sent to the sender after the checks the Worker made: `from` is the mailbox written to, `to` is the sender, one recipient, never our own inboxes, no localhost link. A reply that fails a check is not sent; the fallback gets the mail |
| down, 5xx (after the retry) or timeout | `451` | the raw mail is spooled; the sender's server retries |
| a 4xx or an answer outside the contract | `250` when the fallback took it, else `451` | spooled; the fallback gets the mail, because a retry would get the same answer |

Spool: `/var/spool/dazl-inbound/<key>.eml` + `<key>.json` (from, to, reason, time), owner-only, removed after 30 days.
After an outage, replay the spool (through systemd, so the secrets stay in the env file):

    sudo systemd-run --wait --pipe -p User=dazl-mail -p EnvironmentFile=/etc/dazl-inbound-mail/env \
      -p Environment=DAZL_INBOUND_CONFIG=/etc/dazl-inbound-mail/config.json /usr/bin/python3 /opt/dazl-inbound-mail/receiver.py replay

A replay records the mail in the app and clears the spool; it does not perform the app's action (the SMTP session is
gone, and the sender's server already retried after its `451`).

### Outbound mail

EC2 blocks outbound port 25, so forwards and replies go through `SYSTEM_MAIL_SMTP_URL` (Resend). Resend only sends
From a verified domain (`notify.dazl.ai`), so:

- a **forward** is a new message From `SYSTEM_MAIL_FROM`, Reply-To the real sender, subject `Fwd: ...`, the readable
  text on top and the untouched original attached as `original.eml`. It carries `X-Dazl-Inbound-Forwarded`, and a
  message that arrives with that header is refused (`550 5.4.6`), so a forward can never loop.
- a **reply** keeps the app's message but its From address becomes `SYSTEM_MAIL_FROM`'s (the display name stays) with
  Reply-To the mailbox the customer wrote to. `"reply_from_mode": "as_is"` sends the app's bytes unchanged; use it once
  `dazl.ai` itself is a verified sending domain.

### STARTTLS

Offered when `tls_cert` / `tls_key` exist; otherwise the receiver runs plain and logs `"starttls": false`. Caddy only
has a certificate for `mail.dazl.ai` once DNS points there and the Caddyfile has a site for it (cutover step 4);
`sync-cert.sh` (daily timer) then copies it to `/etc/dazl-inbound-mail/tls` and restarts the receiver when it changes.

## Not done here, on purpose

- **The app does not have `/internal/admin/inbound-email` yet.** Checked 2026-11-14: `POST` to it answers 404 on
  dazl.ai, on staging and on the box's loopback ports; the route lives only in the legacy `dazl-frontdesk` project
  (`dazl-box-backup`, ADR 0011), not in `web/`. Until the app has it, mail to `reply@dazl.ai` takes the 4xx row above:
  it is spooled and handed to `fallback_forward` (with no fallback: `451`). `INBOUND_BACKEND_KEY` is the key that route
  will check; it is empty until then, and an empty key means the app is never called.
- `fallback_forward` and the other Cloudflare routing rules are placeholders in `config.example.json`.
- DNS, the security group and the Caddyfile are not touched by anything in this directory.

## Install (switch off)

    scp ops/inbound-mail/* aws-dazl:/tmp/dazl-inbound-mail-src/
    ssh aws-dazl sudo bash /tmp/dazl-inbound-mail-src/install.sh --mail-env-from /etc/dazl-staging/env

It adds the `python3-aiosmtpd` package, the `dazl-mail` user, `/opt/dazl-inbound-mail`, `/etc/dazl-inbound-mail`
(`config.json`, and `env`: root-only, with the two mail settings copied without printing them), the spool directory and
the units. It never starts the receiver.

## Switch

    sudo touch /etc/dazl-inbound-mail/enabled && sudo systemctl start dazl-inbound-mail      # on
    sudo systemctl stop dazl-inbound-mail && sudo rm /etc/dazl-inbound-mail/enabled          # off

Without the switch file the unit does nothing (`ConditionPathExists`), at boot too. Logs: `journalctl -u
dazl-inbound-mail` (one JSON line per event; never a key or a mail body).

## Cutover (Hermes / Gagan; nothing below is done by this change)

1. On the box: set `fallback_forward`, the routes and `backend_url` in `/etc/dazl-inbound-mail/config.json`, put
   `INBOUND_BACKEND_KEY` in `/etc/dazl-inbound-mail/env` once the app route exists, then
   `python3 /opt/dazl-inbound-mail/receiver.py check-config` and switch on.
2. Security group of the box: inbound TCP 25 from 0.0.0.0/0 (and ::/0 if the box has IPv6).
3. DNS: `A mail.dazl.ai -> 13.59.40.96`, then `MX dazl.ai -> 10 mail.dazl.ai` (replacing Cloudflare's
   `route*.mx.cloudflare.net` records), and the SPF record without `include:_spf.mx.cloudflare.net`.
4. STARTTLS: add `mail.dazl.ai { respond 404 }` to the Caddyfile so Caddy gets the certificate, then
   `sudo systemctl start dazl-inbound-mail-cert.service`.
5. Check from outside: `swaks --to reply@dazl.ai --server mail.dazl.ai` answers, and a relay attempt is refused.

## Memory

Measured on the box (Python 3.12, 2026-11-14): 26 MB idle; 88 MB peak while handling a 9.9 MB message, settling at
63 MB. The unit caps it at `MemoryMax=192M` (several 10 MB messages at once can hit the cap: the service restarts and
the senders retry; the app and the rest of the box are not affected).

## Tests

    python3 -m unittest discover -s ops/inbound-mail -p 'test_*.py' -v

The app is a real local HTTP server answering the contract; the SMTP tests talk to the real server over a socket and
are skipped where `aiosmtpd` is missing (CI installs it).
