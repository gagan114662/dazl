# Owner scripts: run from the owner's Mac (issue #1080)

Small wrappers the owner runs by hand, because only the owner's Mac has ssh access to the box. They were written in a
scratch folder and are kept here so a restart does not lose them. Nothing in CI or on the box runs them.

No script holds a host address, an account, a bucket name or a secret. Each takes the box from `DAZL_SSH_HOST` (the
ssh alias or `user@host` in the owner's `~/.ssh/config`) and stops with a usage line when it is not set.

| script | what it does | changes | who runs it |
|---|---|---|---|
| `reset-staging-trial.sh <email>` | Gives one test account its free trial searches back on **staging**, so a live check can be rerun. | Deletes that account's rows in `trial_reservations` in the staging database, after saving them to a root-only file. Never production. | owner, when Quest asks for a rerun |
| `install-offhost-backup.sh [key file]` | Step 2 of the off-host backup (`ops/backup/README.md`): copies the upload-only key file to the box and runs `ops/backup/install-prod-offhost.sh` from the live release. | Installs the hourly backup timers, takes one backup, removes the copied key file from the home folder. | owner, once, after `ops/backup/aws-setup.sh` |
| `install-downtime-alert.sh` | Runs `ops/uptime/install.sh` from the live release, points the probe at production's alert destination and sends one test message. | Adds `/usr/local/lib/dazl-uptime/`, `/etc/dazl-uptime/env`, `dazl-uptime.timer`. | owner, once |
| `prove-prod-restart.sh [--kill]` | Shows how production is supervised (unit, user, restart and memory settings, starts at boot, boot time next to unit start time). With `--kill`, proves systemd restarts it (issue #1083). | Without `--kill`: nothing. With `--kill`: kills the live production process once; dazl.ai answers 502 until it is back (expected under 30 seconds). | owner, at a quiet moment; the report again after a reboot |
| `setup-offhost-pinger.sh` | Turns on the off-server downtime check (issue #1586, `.github/workflows/offhost-uptime.yml`): copies the box's alert destination into the GitHub repo secret `OPS_ALERT_WEBHOOK_URL` and starts one run that sends a test message. | Sets one GitHub repo secret. Nothing on the box. | owner, once, after `install-downtime-alert.sh` |

## Expected output

`DAZL_SSH_HOST=<box> ops/owner/reset-staging-trial.sh <test account email>`

```
trial rows before: 3 (all accounts: 41)
removed rows saved to /root/trial-reset-<UTC time>.sql
rows removed: 3
trial rows after: 0 (all accounts: 38)
```

The numbers differ; "after" is 0 and "all accounts" drops by exactly the rows removed. Any line starting `FAIL:` ends
with "nothing changed" (no staging database, or not exactly one account with that email). To undo, run the saved
`.sql` file against the staging database.

`DAZL_SSH_HOST=<box> ops/owner/install-offhost-backup.sh`

```
key file copied to the server
installer from: <the live release folder>
... the installer's own lines: three PASS lines, then ALL PASS (ops/backup/README.md, step 2) ...
--- timers ---
<next run> ... dazl-backup.timer  dazl-backup.service
```

The exit code is the installer's. `FAIL: no live release contains ops/backup/install-prod-offhost.sh` means the
change is not deployed to production yet. The secret key is never printed. Without an argument the script uses the
only `*.s3.env` in `~/dazl-backup-keys` and stops when there are none or several.

`DAZL_SSH_HOST=<box> ops/owner/install-downtime-alert.sh`

```
installer from: <the live release folder>
... ops/uptime/install.sh lines ...
env lines: 1, mode 600
--- test alert ---
test alert exit=0
--- first probe run ---
Result=success ExecMainStatus=0
{... one JSON line per run, every check "up": true ...}
<next run> ... dazl-uptime.timer  dazl-uptime.service
```

One test message must arrive at the alert destination (Telegram). Every URL in the output shows as `<url>`. This
probe runs on the box, so it does not notice the box itself being off; the off-host pinger is issue #1586.

`DAZL_SSH_HOST=<box> ops/owner/prove-prod-restart.sh --kill`

```
dazl-prod@3104: active=inactive enabled=disabled
dazl-prod@3105: active=active enabled=enabled
live unit: dazl-prod@3105.service, process <pid>, user ubuntu
settings: Restart=on-failure RestartUSec=3s MemoryMax=1610612736 NoNewPrivileges=yes ProtectSystem=no
restarts so far: 0
box booted: <time>   unit started: <time>
listens on: *:3105
health commit: <40-hex commit>
installed unit file: same as the live release's copy
--- kill test: SIGKILL to dazl-prod@3105.service at <UTC time> ---
healthy again after 9s: process <new pid>, user ubuntu, same commit <40-hex commit>
restarts: 0 -> 1
PASS: systemd restarted production by itself in 9s
```

The live port and the numbers differ. Without `--kill` the output stops after the unit file line with
`REPORT ONLY: nothing changed`. It fails, and says why, when the process is root, the restart takes more than 30
seconds, or the restart counter does not go up by exactly one. `FAIL: no healthy answer 90 seconds after the kill`
means production may be down: run `deploy-prod.sh --status` on the box. For the reboot part of #1083, reboot the box
in a quiet window, log in to nothing, wait for dazl.ai to answer, then run the report: "unit started" is seconds
after "box booted". `listens on: *:<port>` and `ProtectSystem=no` are the two parts of #1083 that are still open.
`DAZL_SSH_HOST=<box> ops/owner/setup-offhost-pinger.sh`

```
secret OPS_ALERT_WEBHOOK_URL set on <owner>/<repository>
test run started: one message, 'dazl test alert from the off-server check', should arrive within a minute or two
watch it: gh run list --workflow offhost-uptime.yml --limit 3
```

**Until this script has run once, the off-server check sends nothing:** the repository has no secret named
`OPS_ALERT_WEBHOOK_URL`, so a run still goes red when production is down, but no message leaves. The one command
above sets the secret and sends the test alert. To check or repeat either part by hand:

```bash
gh secret list | grep OPS_ALERT_WEBHOOK_URL                  # the secret exists (the value is never shown)
gh workflow run offhost-uptime.yml -f test_alert=true        # send the test alert again
gh run list --workflow offhost-uptime.yml --limit 3          # the test run: completed, success
```

One test message must arrive in Telegram and the run must be green. The destination is never printed. From then on
GitHub asks `https://dazl.ai/api/health` about every 5 minutes (it starts scheduled runs late when busy, often 5 to
15 minutes) and sends "dazl.ai is DOWN" once, "STILL DOWN" once per further hour and "BACK UP" once. The stop test
for #1586: with production's web server stopped for 15 minutes in a quiet window, the DOWN message arrives. GitHub
turns scheduled runs off in a repository with no commits for 60 days; it emails the owner first.

## Checks

`bash -n` on each script, and `shellcheck -S error` in `.github/workflows/never-again-gates.yml`. The scripts
themselves are only ever run by the owner against the real box; there is no automated run of them.
