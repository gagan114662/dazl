# Alerts and uptime for production (issue #1088)

Three free pieces. None needs a new account beyond a Telegram bot the operator already owns.

## 1. One alert destination: `OPS_ALERT_WEBHOOK_URL`

Every sender uses it: the app's error hook (`web/lib/ops/errors.ts`), the backup check, the scheduler check and the
uptime probe below. It is one https URL:

| destination | URL | what is sent |
|---|---|---|
| Telegram bot | `https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat id>` | `{ chat_id, text }`: the alert as a short readable block |
| Slack-style webhook or a relay | any other https URL | the structured JSON plus a `text` summary |

The bot token is a secret: it goes into the env files below (mode 600), never into the repository, an issue or a log
(the senders log the HTTP status only). Get the chat id by sending the bot a message and reading
`https://api.telegram.org/bot<token>/getUpdates` once.

Where to set it (Hermes; the app picks it up at the next deploy, the timers at their next run):
- the app: `OPS_ALERT_WEBHOOK_URL=...` in the run env (`/home/ubuntu/dazl-pr16-run.env`), then deploy;
- the backup check: the line `OPS_ALERT_WEBHOOK_URL=...` in `/etc/dazl-backup/env`;
- the scheduler check: its unit's env file (`ops/scheduler/`);
- the uptime probe: `/etc/dazl-uptime/env` (the system install below) or `~/.config/dazl-uptime/env` (the user unit).

**Send a test alert** (one command; it probes nothing and does not touch the app). One message, "dazl test alert from
`<host>` ...: alerts reach this destination", must arrive; exit 1 and the reason in words when it does not:

```bash
sudo /usr/local/lib/dazl-uptime/send-test-alert.sh                    # the installed probe's destination (/etc/dazl-uptime/env)
ops/uptime/send-test-alert.sh ~/.config/dazl-uptime/env               # the user-unit install
OPS_ALERT_WEBHOOK_URL='<the URL>' ops/uptime/send-test-alert.sh -     # any machine with a checkout, no env file
```

`SENTRY_DSN` stays unset: it is a new external data destination and the owner has not confirmed it.

## 2. External uptime checks: `probe.mjs`

Runs every minute on a machine that is **not** the production box (the PC that already runs Hermes is fine): prod
health, the prod scheduler's own state and staging health. A check is DOWN after 2 failures in a row (about 2 minutes),
alerts once, reminds every hour while it stays down and says when it is back. Why not a hosted checker: Better Stack
and UptimeRobot are free too, but each is a new account and a new place that holds the alert destination; this is one
file on a machine we already run. If that machine is off, nothing watches: keep it on, or add a hosted checker later.

**Install as a system timer** (any Linux machine with systemd and Node 20+ on root's `PATH`; once, as root, from a
reviewed checkout):

```bash
sudo ops/uptime/install.sh                             # probe + unit + timer; creates an empty /etc/dazl-uptime/env (root, 600); enables the timer
sudoedit /etc/dazl-uptime/env                          # ONE line: OPS_ALERT_WEBHOOK_URL=<the alert URL>
sudo /usr/local/lib/dazl-uptime/send-test-alert.sh     # the test message arrives
systemctl list-timers dazl-uptime.timer                # next run within a minute
journalctl -u dazl-uptime.service -n 5                 # one JSON line per run: every check "up": true
```

The probe runs as a throwaway unprivileged user (`DynamicUser`) and reads public URLs only. Run `install.sh` again
after `probe.mjs` changes. It may be installed on the production box itself when there is no second machine: it then
still catches the app, Caddy, the certificate and DNS failing (it goes out to `https://dazl.ai` and back), but
**not the box being off or unreachable**, so a second machine or a hosted checker is still wanted for that.

**Install as a user timer** (no root; a desktop or another server): the header of `dazl-uptime.service`, or one cron line.

## 2b. Stalled workspaces (#1090)

`/api/health/scheduler` carries `stalls` (`web/lib/ops/stalls.ts`), counts only: `needs_reconnect` (mailboxes that
need the user to reconnect), `held_over_24h` (workspaces with autopilot on whose waiting first touches have all been
held for a day or more) and `scans_stuck` (scans still running past their deadline). They do not change that
endpoint's status. The probe's scheduler check reads them: while any is above zero it sends one alert ("work is
stalled for some workspaces: 2 mailbox(es) need reconnect, ..."), then one a day (`--stall-remind-s`, 86400) until all
are zero. Nothing to install beyond the probe; read them by hand with
`curl -s https://dazl.ai/api/health/scheduler | python3 -c 'import json,sys; print(json.load(sys.stdin)["stalls"])'`.

## 3. Server-action probes

Bots POST requests with a `Next-Action` header at every path. The app has no server actions, so `web/proxy.ts` answers
them with a plain 400 and one request-log line; before, each one printed a "Failed to find Server Action" stack trace
in the prod log (706 in 41 h). Nothing to configure.
