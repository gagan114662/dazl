# ops/prod: the production deploy scripts

These are the files the dazl.ai box runs. They are copies of what is installed in `/usr/local/lib/dazl-prod/`, taken byte
for byte, so what runs is a reviewed file in this repository (NEVER-AGAIN #1, #2; #1140).

| file | what it is |
| --- | --- |
| `deploy-prod.sh` | the **v2** deploy (blue/green on :3104/:3105, systemd units `dazl-prod@<port>`, rollback, `--stop-port`, `--status`). Run as root by the ops door. Never builds on the box. |
| `run-release.sh` | `ExecStart` of `dazl-prod@<port>.service`: loads the release env and runs `next start` directly. |
| `pull-release.sh` | downloads and verifies the prebuilt build that GitHub made (size, sha256, `.build-commit`) and unpacks it. |
| `check-installed.sh` | read-only: compares the installed copies with these, by sha256. Exit 1 and the file's name when one differs or is missing. |
| `prebuilt-manifest.mjs` | builds the manifest the prebuilt workflow publishes. |
| `legacy-v1/deploy-prod.sh` | the old v1 script from #1061. **Not what runs on the box. Never install it**: it refuses to run unless a test sets a variable. Kept only so `test_prod_prebuilt.py` can exercise `pull-release.sh` end to end. |

**Changing a deploy script:** edit it here, review the diff, install it on the box, copy the installed file back, and update
`PINNED` in `test_prod_v2.py`. `check-installed.sh` on the box then prints `installed = repo` for all five.

**New-host provisioning:** before using the workflow fallback `sudo /usr/local/lib/dazl-prod/deploy-prod.sh`, provision the reviewed deploy script and its four siblings (`pull-release.sh`, `run-release.sh`, `check-pages.py`, `check-hydration.mjs`) in `/usr/local/lib/dazl-prod`, owned by root and not writable by the deploy account. Run `ops/prod/check-installed.sh` from the reviewed checkout to verify all five. The run environment is managed separately; do not overwrite it when installing scripts or pulling a release.

**What the tests cannot run:** v2's happy path (the blue/green switch) needs the real host: systemd, `ss`, `/proc` cgroups, Caddy,
and a guard that reads the real `/etc/caddy/Caddyfile`. `test_prod_v2.py` runs the refusals v2 makes before it changes anything.

**Disk cleanup:** after a reviewed pair of v2 scripts has been installed and
`check-installed.sh` matches, preview the next exact deployment without removing
anything:

```sh
sudo /usr/local/lib/dazl-prod/deploy-prod.sh --cleanup-plan <40-hex-commit>
```

It uses the production deployment lock and checks the live Caddy port and
process. The normal authorized deploy then removes only stale deploy artifacts:
unused exact-name release directories owned by the app user; known older
prebuilt archive/sidecar files; and old predeploy backup files beyond the five
newest (or the higher `PROD_KEEP_BACKUPS` setting). Live, previous, target,
configured and listening releases are kept, as are live/previous/target
prebuilt caches and releases/caches modified in the last hour. A new backup gets its existing
SQLite integrity check before any post-backup retention. Prebuilt download and
extraction still obey the same disk floor. This does not clean browser caches,
nightly/off-host backups, or the live database and its sidecars.
