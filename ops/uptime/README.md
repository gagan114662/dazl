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
- the backup check: `/etc/dazl-backup/env` (`ops/backup/install-prod.sh --alert-url ...`);
- the scheduler check: its unit's env file (`ops/scheduler/`);
- the uptime probe: `~/.config/dazl-uptime/env` on the probe machine.

Test it end to end (acceptance 4), from any machine, without touching the app:

```bash
OPS_ALERT_WEBHOOK_URL='<the URL>' node ops/uptime/probe.mjs --state /tmp/uptime-test.json \
  --check test=https://dazl.ai/api/health/does-not-exist --fail-after 1      # one "dazl test is DOWN: HTTP 404" message arrives
```

`SENTRY_DSN` stays unset: it is a new external data destination and the owner has not confirmed it.

## 2. External uptime checks: `probe.mjs`

Runs every minute on a machine that is **not** the production box (the PC that already runs Hermes is fine): prod
health, the prod scheduler's own state and staging health. A check is DOWN after 2 failures in a row (about 2 minutes),
alerts once, reminds every hour while it stays down and says when it is back. Install: the header of
`dazl-uptime.service` (a systemd user timer, or one cron line). Why not a hosted checker: Better Stack and UptimeRobot
are free too, but each is a new account and a new place that holds the alert destination; this is one file on a
machine we already run. If that machine is off, nothing watches: keep it on, or add a hosted checker later.

## 3. Server-action probes

Bots POST requests with a `Next-Action` header at every path. The app has no server actions, so `web/proxy.ts` answers
them with a plain 400 and one request-log line; before, each one printed a "Failed to find Server Action" stack trace
in the prod log (706 in 41 h). Nothing to configure.
