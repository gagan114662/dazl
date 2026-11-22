# ops/prod: the production deploy scripts

These are the files the dazl.ai box runs. They are copies of what is installed in `/usr/local/lib/dazl-prod/`, taken byte
for byte, so what runs is a reviewed file in this repository (NEVER-AGAIN #1, #2; #1140).

| file | what it is |
| --- | --- |
| `deploy-prod.sh` | the **v2** deploy (blue/green on :3104/:3105, systemd units `dazl-prod@<port>`, rollback, `--stop-port`, `--status`). Run as root by the ops door. Never builds on the box. |
| `run-release.sh` | `ExecStart` of `dazl-prod@<port>.service`: loads the release env and runs `next start` directly. |
| `pull-release.sh` | downloads and verifies the prebuilt build that GitHub made (size, sha256, `.build-commit`) and unpacks it. |
| `dazl-prod@.service` | the systemd unit template behind `dazl-prod@<port>`: the app user (never root), `Restart=on-failure`, enabled at boot by the deploy. See "Supervised process (#1083)" below. |
| `check-installed.sh` | read-only: compares the installed copies (and, on the box, the installed unit template) with these, by sha256. Exit 1 and the file's name when one differs or is missing. |
| `prebuilt-manifest.mjs` | builds the manifest the prebuilt workflow publishes. |
| `legacy-v1/deploy-prod.sh` | the old v1 script from #1061. **Not what runs on the box. Never install it**: it refuses to run unless a test sets a variable. Kept only so `test_prod_prebuilt.py` can exercise `pull-release.sh` end to end. |

**Changing a deploy script:** edit it here, review the diff, install it on the box, copy the installed file back, and update
`PINNED` in `test_prod_v2.py`. `check-installed.sh` on the box then prints `installed = repo` for all five.

**New-host provisioning:** before using the workflow fallback `sudo /usr/local/lib/dazl-prod/deploy-prod.sh`, provision the reviewed deploy script and its four siblings (`pull-release.sh`, `run-release.sh`, `check-pages.py`, `check-hydration.mjs`) in `/usr/local/lib/dazl-prod`, owned by root and not writable by the deploy account. Run `ops/prod/check-installed.sh` from the reviewed checkout to verify all five. The run environment is managed separately; do not overwrite it when installing scripts or pulling a release.

## Supervised process (#1083)

Production runs as `dazl-prod@<port>.service` (ports 3104 and 3105, blue/green): the app user, `Restart=on-failure`,
logs in the journal. Nobody starts it by hand: `deploy-prod.sh` writes `/etc/dazl-prod/ports/<port>.conf`, starts the
spare port's instance, switches Caddy, then enables the live instance at boot and disables the other.

**Install once (on the box, as root, from a reviewed checkout of this repository):**

```bash
systemctl cat 'dazl-prod@.service'   # a unit already there? diff it with ops/prod/dazl-prod@.service and settle the difference in review first
install -o root -g root -m 644 'ops/prod/dazl-prod@.service' /etc/systemd/system/
systemctl daemon-reload
ops/prod/check-installed.sh          # every script and the unit template: "installed = repo"
```

**Move from a hand-started process, with no downtime:** the deploy never stops the port Caddy points at, so deploying
the commit that is already live starts the same release under systemd on the spare port and switches to it only after
it answers.

```bash
/usr/local/lib/dazl-prod/deploy-prod.sh --status                   # the live port, and unit=inactive for a hand-started process
curl -s https://dazl.ai/api/health                                 # "commit": the 40-hex sha that is live now
/usr/local/lib/dazl-prod/deploy-prod.sh <that sha>                 # same release on the spare port, as dazl-prod@<spare>; Caddy switches after the smoke checks
/usr/local/lib/dazl-prod/deploy-prod.sh --status                   # live port: unit=active enabled=enabled
ps -o user= -p "$(systemctl show -p MainPID --value 'dazl-prod@<new port>.service')"   # the app user, not root
/usr/local/lib/dazl-prod/deploy-prod.sh --stop-port <old port>     # later: stops the hand-started process (refused while Caddy points at it)
```

Until the last command the old process keeps running, so `deploy-prod.sh --rollback` still works. Proof that it is
supervised: `systemctl kill -s KILL 'dazl-prod@<live port>.service'`, then `https://dazl.ai/api/health` answers again
within seconds and `systemctl show -p NRestarts 'dazl-prod@<live port>.service'` has gone up by one. A reboot test
belongs in a maintenance window.

Not covered by this unit (still open on #1083): binding to loopback only (`run-release.sh` starts `next start` without
`-H`) and filesystem sandboxing (`ProtectSystem`).

**What the tests cannot run:** v2's happy path (the blue/green switch) needs the real host: systemd, `ss`, `/proc` cgroups, Caddy,
and a guard that reads the real `/etc/caddy/Caddyfile`. `test_prod_v2.py` runs the refusals v2 makes before it changes anything.
