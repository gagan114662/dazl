# Recovery: backups, targets and the restore drill (issue #360)

This document says what is known, sets the targets, gives the isolated restore plan, and lists exactly what Instinct must run or provision. Nothing here has been run on the production host, and no off-host backup is set up by this change: the live steps are in "Live drill (Instinct)" below.

Related:
- `web/docs/backup-runbook.md`: taking a backup and the content-only restore drill.
- `web/docs/master-key-rotation.md`: rotating the master key.

## What is known today (from the repository)

| item | state |
|---|---|
| Online SQLite backup (`web/scripts/backup/create-backup.ts`) | exists, tested. One self-contained file plus a `.json` sidecar (sha256, createdAt). |
| Content restore drill (`restore-drill.ts`) | exists, tested. Checks integrity, schema, row counts and full-content hashes. |
| Full recovery drill (`recovery-drill.mts`, this change) | exists, tested. Covers content, decryption of every stored secret under the recovered key, unresolved-send inventory, and the app started on the restored copy with sending disabled. Every step is timed. |
| Host inventory (`ops/backup-inventory.sh`) | exists. Read-only, metadata only. **Not yet run on the host.** |
| Encrypted off-host copy (`ops/backup/offhost-copy.sh`), scheduled run (`run-backup.sh`), freshness alert (`backup-check.mts`), systemd templates | exist, tested. **Not installed.** No destination is chosen. |
| Retention (`prune-backups.mts`, run by `run-backup.sh`) | exists, tested. **Off** (`BACKUP_RETENTION=0`) until Instinct turns it on after the first verified off-host cycle. Refuses the whole run while the newest backup or its drill is in doubt; never deletes a local backup without a complete off-host copy. |
| Secrets/config bundle (`config-backup.mts`, `dazl-config-backup.timer`) | exists, tested. Env file, Caddyfile and unit files, `DAZL_MASTER_KEY*` replaced by a placeholder, encrypted to its **own** age recipients. **Not installed.** |
| Replacement-host restore drill (`replacement-drill.mts`) | exists, tested end to end on synthetic data in CI (`npm run test:smoke:replacement`). Writes the dated restore report with measured RPO/RTO and sign-in/decrypt/scan/read checks. **Not yet run on a real replacement host.** |
| Separate key-recovery drill (`replacement-drill.mts --mode keys`) | exists, tested. Monitored by `backup-check.mts` (`KEY_DRILL_REPORT`, quarterly). **Not yet run with the real offline keys.** |
| Send gate (`send-gate.mts`) | exists, tested. Exits 0 only when nothing is `sending`/`uncertain` and every old lease has expired; sending stays off until then. |
| A backup schedule on the host | **unknown.** Nothing in the repo installs one. |
| Off-host copies (EBS snapshots, AWS Backup, S3, anything else) | **unknown.** The inventory reports them. |
| Where `DAZL_MASTER_KEY` is kept besides the env file | **unknown, owner only.** Without it, restored LLM keys, connector secrets and Gmail tokens are unreadable. |
| Restore ever performed on the host | no (backup-runbook.md). |

## Step 1: inventory (Instinct, on the host, read-only)

```bash
bash ops/backup-inventory.sh --db <production DB_PATH> --backup-dir /var/backups/dazl > /tmp/dazl-inventory.json
```

It reports:
- the live database's size and last-write age;
- local backups (count, newest and oldest age, bytes, sidecars);
- cron lines and systemd timers that mention backups;
- which off-host tools are installed;
- on EC2 with instance credentials: the instance's EBS volumes, their snapshot counts and newest snapshot, DLM policies and AWS Backup plans.

It never opens the database, a backup, an env file or a secret. Attach its output to #360.

## Targets

Decision (Hermes, under delegation, 2026-11-03; posted on #360; reversible by changing the numbers below and in `/etc/dazl-backup/env`): these are the service targets. The drill judges against them with `--rpo-target-s 3600 --rto-target-s 14400`.

| target | value | why |
|---|---|---|
| RPO, data loss on host or disk loss | **1 hour** | hourly online backup plus an hourly encrypted off-host copy. The database is small, so a backup takes milliseconds to seconds. |
| RTO, database corrupted or a bad release on a working host | **30 minutes** | restore the newest passing backup in place (backup-runbook.md "Actually recovering"). The drill measures the software part. |
| RTO, host lost | **4 hours** | provision a replacement host, install the release, fetch and decrypt the off-host copy, restore secrets and config, start, check, switch DNS or Caddy. Dominated by provisioning. |
| Retention, local | 48 hourly | at least two days of fine-grained points on the box |
| Retention, off-host | 14 daily plus 8 weekly | about two months of history. Deletion is policy; #359 ties backup expiry to tenant deletion. |
| Backup alert | newest good backup older than 2 hours, newest off-host copy older than 2 hours, or the last drill failed, was never reported, or is more than 2 hours old (the drill runs on every backup) | `backup-check.mts`, every 15 minutes |
| Drill cadence | the content and key drill on every backup; the full app drill weekly and after every release | content and key checks take milliseconds |

## Key recovery (separate from the backups)

- **The master key.** `DAZL_MASTER_KEY` must exist in two places other than the host's env file, and never next to the backups. Suggested: the owner's password manager, plus a sealed offline copy.
- **The off-host encryption identity.** The `age` private key is stored the same way, but separately from the master key. Then one leaked store exposes neither the data nor the secrets inside it.
- **Testing key recovery separately.** At least quarterly, a person other than the one who stored it recovers the key from its offline copy into a mode-600 file. They then run the drill with that file:

```bash
node --experimental-strip-types scripts/backup/recovery-drill.mts --backup <newest> --key-file <recovered key file> --work-dir <new dir> --report report.json
```

  The `key recovery` step must show `failed: 0` over a nonzero `total`. A wrong or stale key fails with a count per column; no key material or plaintext is printed.

## Step 2: the isolated restore drill (Instinct; no production change)

Run it on the production host or, better, on a replacement host built from scratch. Run as the app's user, into a private directory outside the live database's directory:

```bash
cd <release>/web
node --experimental-strip-types scripts/backup/recovery-drill.mts \
  --backup /var/backups/dazl/<newest>.db --key-file /root/recovered-master.key \
  --work-dir /var/tmp/dazl-drill-$(date -u +%Y%m%dT%H%M%SZ) --app "$PWD" --report /root/drill-report.json
```

The drill runs four steps.

1. **content.** The backup matches its sidecar and restores faithfully: integrity, schema, rows and full-content hashes. The backup file itself is untouched.
2. **key recovery.** Every registered ciphertext (LLM keys, connector secrets, Gmail refresh tokens) decrypts in full under the recovered key. Plaintexts are discarded at once.
3. **send safety.** Counts what must be reconciled before sending is re-enabled: claims still `sending`, `uncertain` messages, sequence and follow-up steps, unexpired worker leases, tenants with autopilot on.
4. **app readability** (`--app`). That release's production build starts on the restored copy, and sending is disabled three ways:
   - `AUTOPILOT_KILL=1`;
   - no tick secret, so `/api/internal/tick` answers 404;
   - the network fence, so nothing leaves the machine: no email, Stripe, Gmail or LLM call.

   `/api/ready` must answer ok. For the tenant with the most leads, a session created **in the restored copy only** must read its scans, leads and key status, and `/app/leads` must render.

**What the report records:**
- `rpo_at_drill_s`: the backup's age when drilled.
- `measured_rto_ms`: the drill's wall time to app ready.
- Each step's time and counts.

It contains no tenant data, keys or plaintext. The restored copy is deleted afterwards (pass `--keep-work-dir` to inspect it). The drill refuses to run when:
- the work directory already exists or sits inside `DB_PATH`'s directory;
- the "backup" is the live database itself;
- the key file is readable by others.

**Acceptance for #360:** attach a dated drill report from the host that passes all four steps. Add the measured time for each manual step of the plan below, timed with a stopwatch. Also attach a separate key-recovery drill report made from the offline copy of the key.

## Off-host copies and monitoring (templates; installed only after approval)

**Scheduled backup.** `ops/backup/run-backup.sh` runs hourly from `dazl-backup.timer`, as the app's user. Each run:
1. takes an online snapshot with `create-backup.ts`;
2. checks it restores faithfully with `restore-drill.ts`, and fails the run otherwise. The drill writes its report - pass **or fail** - to `$BACKUP_DIR/drill-report.json` (the `DRILL_REPORT` setting overrides it; `backup-check.mts` reads the same setting, so the producer and the monitor cannot drift). The report is written mode 600 via a `.partial` rename, so the monitor never reads a half-written one;
3. when `OFFHOST_DEST` is set, runs `offhost-copy.sh`.

The settings live in `/etc/dazl-backup/env` (`ops/backup/env.example`). They hold no secrets: the database is only read, and the off-host recipients are public keys.

**Encrypted off-host copy.** `ops/backup/offhost-copy.sh`:
- copies only backups that match their sidecar sha256;
- encrypts with `age` to the **public** keys in `OFFHOST_AGE_RECIPIENTS`, and refuses a private key there;
- writes `<backup>.age` and a manifest (plaintext and ciphertext sha256, bytes, times, recipient public keys) to `OFFHOST_DEST`. The destination is a mounted directory or `rclone:REMOTE:PATH`;
- reads the uploaded file back and compares its hash.

The host can write copies it cannot decrypt. The matching private key stays offline (see Key recovery).

To restore from it, decrypt with the offline identity, then run the drill:

```bash
age -d -i <identity file> -o restored.db <backup>.age
```

The `.db.json` sidecar travels inside the manifest's `source_sha256`. Recreate it, or drill with `restore-drill.ts`, which warns when there is no sidecar.

**Freshness alert.** `scripts/backup/backup-check.mts` runs every 15 minutes from `dazl-backup-check.timer`. It exits 1 and alerts in any of these cases:
- there is no local backup;
- the newest local backup is older than the limit, or no longer matches its sidecar;
- the off-host copy is not recoverable. It is checked at the **same `OFFHOST_DEST`** the backup copies to (a directory, or `rclone:REMOTE:PATH` through the app user's rclone config). It counts as a problem when:
  - the destination cannot be read (rclone missing or failing);
  - there is no copy manifest;
  - the newest copy is too old;
  - the newest manifest's **ciphertext is absent, has other bytes than declared, or does not hash to its declared sha256**. A manifest alone is not a backup.
- `OFFHOST_REQUIRED=1` is set (once the owner has chosen a destination) and no destination is configured;
- the drill report is missing, failing (the alert names the failed step), or older than 2 hours. The report exists because every `dazl-backup.service` run writes it; a manual `recovery-drill.mts --report` to the same path also counts. `backup-check.mts` resolves it as: `--drill-report` flag, else `DRILL_REPORT` from the environment, else `$BACKUP_DIR/drill-report.json`.

Alerts go to `OPS_ALERT_WEBHOOK_URL` (https only; redirects are not followed, so a hook that redirects to plain http fails rather than leaking the alert). The same problems alert at most once per `BACKUP_ALERT_EVERY_S` (default 3600; `0` means every run; an invalid value falls back to 3600 with a log line), counted from a delivered alert: a failed delivery (webhook error or non-2xx, no destination) is retried on the next run, and the problem stays in the journal either way. There is deliberately no recovery notice: when the problem clears, the next alert is simply not sent. Every rclone call the monitor makes is bounded by `RCLONE_TIMEOUT_S` (a positive integer, default 120; `0`, negative or non-numeric values fall back to 120 with a log line, because `0` would mean no bound): a hung remote is reported as a problem, never a hung check. Only the newest few manifests are read each run (`dazl-backup-*` names by their embedded timestamp first, other names after), so the check stays fast as copies accrue; older copies are counted, not judged. Keep only `dazl-backup-*` names at the destination: a manual copy under another name is judged only when fewer than five dazl copies exist. A hung rclone helper that starts its own session escapes the monitor's process-group kill; only the unit's `TimeoutStartSec` ends that run, and it sends no alert. A few slow calls can still add up past the unit's 5-minute `TimeoutStartSec`; a run killed there has sent no alert and shows as a failed unit in the journal. Alerts carry problems, ages and file names, never data or paths.
Known transient: `create-backup` writes its `.db.json` sidecar in place, so a check that reads it at that instant can raise one "unreadable sidecar" alert (throttled for an hour); the next run clears it. The off-host manifest is written with a rename, so it has no such window.

**Retention** (`scripts/backup/prune-backups.mts`, step 4 of `run-backup.sh`). Off until `BACKUP_RETENTION=1`; Instinct sets it after the first verified off-host cycle (install step 7). Then, after every passing backup:
- local: the newest `RETAIN_LOCAL` (48) are kept;
- off-host: the newest `RETAIN_OFFHOST_HOURLY` (48), plus the newest copy of each of the last `RETAIN_OFFHOST_DAILY` (14) UTC days and `RETAIN_OFFHOST_WEEKLY` (8) ISO weeks.

It refuses the whole run (exit 1, nothing deleted) when a number is malformed, the newest backup no longer matches its sidecar, the drill report is missing or failing, or the destination cannot be listed. It never deletes a file it did not name, a future-dated one, one with an unreadable sidecar, or a local backup whose off-host copy is not complete (`.age` and `.age.json`). `dazl-config-*` bundles are never pruned. #359 (tenant deletion) decides how deleted tenants age out of backups; with these numbers, a deleted tenant's rows leave the last off-host copy after about 8 weeks.

## Secrets and config

A database backup alone does not bring the service back. `scripts/backup/config-backup.mts` (daily, as root, `dazl-config-backup.timer`) bundles the files in `CONFIG_FILES` (the env file, the Caddyfile, the unit files), replaces every `DAZL_MASTER_KEY*` value with `__RESTORE_FROM_OFFLINE_KEY_STORE__`, checks no original key value is left anywhere in the bundle, encrypts it to `CONFIG_AGE_RECIPIENTS` and writes `dazl-config-<ts>-<rand>.tar.age` plus its manifest next to the database copies. It refuses (exit 2, nothing copied) recipients that hold a private key or share any key with `OFFHOST_AGE_RECIPIENTS`, an age identity inside a listed file, and missing, non-regular, relative, duplicate or >1 MB files. It uploads unless the newest bundle at the destination already holds this content and its ciphertext is there (decided from the destination, so a lost state, another host or a deleted bundle never leaves it stale). `backup-check.mts` verifies the newest bundle against its manifest (`CONFIG_REQUIRED=1` makes "none" a problem).

So three keys exist, each in its own offline store, and none of them on the host or in any backup:
1. the **data identity** (opens the database copies),
2. the **config identity** (opens the secrets/config bundle),
3. the **master key** (`DAZL_MASTER_KEY`, decrypts the stored secrets inside the database).

One leaked store opens nothing useful on its own.

## Replacement-host restore drill

`scripts/backup/replacement-drill.mts` rebuilds the service from what survives the host: the off-host destination and the three offline keys. It runs, timing each step:
1. **fetch** the newest `dazl-backup-*` copy and check its bytes and sha256 against the manifest;
2. **decrypt** it with the data identity, check the plaintext sha256, and prove the config identity cannot open it;
3. **secrets and config**: fetch, check and decrypt the newest bundle with the config identity, refuse absolute, traversal or link entries before extracting, check every file against the bundle manifest, check the master-key lines hold the placeholder and the key appears in no restored file, and prove the data identity cannot open it;
4. **recovery drill** (`recovery-drill.mts --app`) on the restored copy with the recovered master key: content, every stored secret decrypts, the send-safety counts, and the release's production build started on the copy with sending disabled. On it: a real password sign-in (a drill-only account made in the copy: sign-up, sign-out, sign-in, signed-in read, wrong password 401), the busiest tenant's scans, leads and key status read, `/app/leads` rendered, a scan accepted (202) and read back, the tick refused (404);
5. **sending** stays disabled; the report names the counts that block re-enabling it.

It writes `restore-report-<UTC stamp>.json` and `.md` to `--report-dir`: date, host, release, the copy restored, measured RPO (drill start minus the backup's `createdAt`), measured RTO (the drill's wall time plus the `--manual` stopwatch seconds for provisioning, installing and DNS; without `--manual` the RTO is marked incomplete), each target met or missed, each check and step. It holds names, counts, hashes and times only. It refuses (exit 2) when a key file is readable by group or others, the two identities share a key, the master key is not 32 bytes, the work directory exists or sits in the live database's directory, there is no production build, or age is missing. Exit 1 names the failed step.

CI runs the whole path on synthetic data on every PR (`release-gate.yml`, step "Replacement-host restore drill"): `offhost-copy.sh` and `config-backup.mts` write to a local directory, the "old host" is deleted, and the drill restores from the directory and the keys alone. A missing build or age is a failure there, never a skip.

**Key-recovery drill (separate, quarterly).** `--mode keys` runs steps 1 to 4 without the app. A person other than the one who stored the keys recovers all three from their offline stores into mode-600 files and runs it; `--report /var/backups/dazl/key-drill-report.json` is the file `backup-check.mts` watches once `KEY_DRILL_REPORT` is set (missing, failed or older than 92 days alerts).

**Send gate.** `scripts/backup/send-gate.mts --db <restored app.db>` is read-only and exits 0 only when no outreach message, sequence step or follow-up is `sending` or `uncertain` and no lease taken on the old host is unexpired; a missing or unreadable database exits 2, never "clear". `AUTOPILOT_KILL` stays set and the tick secret stays off until it exits 0.

**Install (Instinct, after approval):**
1. Copy `ops/backup/*.service` and `*.timer` to `/etc/systemd/system/` and replace the `CHANGE-ME` user and paths (also `RCLONE_CONFIG` in `dazl-config-backup.service`).
2. Create `/etc/dazl-backup/env` (`ops/backup/env.example`; set `CONFIG_FILES`), `recipients.txt` (data public key) and `config-recipients.txt` (config public key). The two private keys and the master key go to their offline stores ("Secrets and config"), never to this host.
3. Run `rclone config` as the app user if using rclone.
4. Run `systemctl daemon-reload && systemctl enable --now dazl-backup.timer dazl-backup-check.timer dazl-config-backup.timer`, then `systemctl start dazl-config-backup.service` once (the first bundle).
5. Check with `systemctl start dazl-backup.service && journalctl -u dazl-backup -n 20`. This first run also writes the first drill report, so the monitor's drill leg starts green; until a first run completes, "no readable recovery drill report" is the honest state, not a fault.
6. Check the monitor: `systemctl start dazl-backup-check.service && journalctl -u dazl-backup-check -n 20` - one JSON line, `"ok":true` once a first backup and its drill report exist.
7. Once that line shows `newest_offhost_verified: true` and `config_verified: true`: set `OFFHOST_REQUIRED=1`, `CONFIG_REQUIRED=1` and `BACKUP_RETENTION=1` in `/etc/dazl-backup/env`. After the first key drill (below), set `KEY_DRILL_REPORT=/var/backups/dazl/key-drill-report.json`.

## Live drill (Instinct; the only steps code cannot do)

Everything above is proved on synthetic data in CI. What closes #360 is this, run by Instinct, with the reports attached to the issue. No production data leaves the host unencrypted, and sending is never enabled on the replacement.

**A. On the production host, as root** (after install steps 1 to 6 with the R2 destination):

```bash
systemctl start dazl-backup.service dazl-config-backup.service dazl-backup-check.service
journalctl -u dazl-backup -u dazl-config-backup -u dazl-backup-check -n 30 --no-pager   # backup ok, config_copy ok, "ok":true
rclone --config /home/<app-user>/.config/rclone/rclone.conf lsf r2:dazl-backups | tail   # dazl-backup-*.age(.json), dazl-config-*.tar.age(.json)
```

**B. Missed and failed backup alerts** (on the host, with `OPS_ALERT_WEBHOOK_URL` set):

```bash
systemctl stop dazl-backup.timer          # no new backup: after 2 h the 15-minute check alerts "newest backup ... old"
journalctl -u dazl-backup-check -n 5 --no-pager; systemctl start dazl-backup.timer
sudo -u <app-user> env $(grep -v '^#' /etc/dazl-backup/env | xargs) OFFHOST_DEST=rclone:r2:dazl-backups-missing \
  node --experimental-strip-types scripts/backup/backup-check.mts --dir /var/backups/dazl --state-dir /var/tmp/dazl-alert-drill   # an unreadable destination: exit 1 and one delivered alert
```

**C. Key recovery, separately** (quarterly; someone other than the person who stored the keys fetches all three from their offline stores into mode-600 files on any machine with Node 22, age, rclone and a checkout of the release):

```bash
cd <release>/web
node --experimental-strip-types scripts/backup/replacement-drill.mts --mode keys --offhost rclone:r2:dazl-backups \
  --identity ~/keys/data-identity.txt --config-identity ~/keys/config-identity.txt --key-file ~/keys/master.key \
  --work-dir /var/tmp/dazl-keydrill-$(date -u +%Y%m%dT%H%M%SZ) --report ~/key-drill-report.json
# then copy key-drill-report.json to the host's /var/backups/dazl/key-drill-report.json and set KEY_DRILL_REPORT (step 7)
```

**D. Replacement host** (a temporary instance, no DNS, no inbound 80/443 from the internet; stopwatch the manual steps):

```bash
# provision (stopwatch: P s), then install Node 22, age, rclone, git; the R2 rclone remote (read-only token is enough)
git clone https://github.com/gagan114662/dazl && cd dazl && git checkout <release sha> && cd web && npm ci && npm run build   # stopwatch: I s
node --experimental-strip-types scripts/backup/replacement-drill.mts --offhost rclone:r2:dazl-backups \
  --identity ~/keys/data-identity.txt --config-identity ~/keys/config-identity.txt --key-file ~/keys/master.key \
  --work-dir /var/tmp/dazl-replacement-$(date -u +%Y%m%dT%H%M%SZ) --app "$PWD" --report-dir ~/restore-reports \
  --manual provision=P,install=I,dns=D --rpo-target-s 3600 --rto-target-s 14400
# D = the timed DNS/Caddy switch of a rehearsal (or the TTL); the switch itself is NOT done in a drill
node --experimental-strip-types scripts/backup/send-gate.mts --db <the restored app.db if --keep-work-dir>   # informational on a drill
```

Attach `restore-report-<stamp>.md` and `.json` and the key-drill report to #360. Pass means: `Result: PASS`, every check `pass` (data copy restored, config and secrets restored, keys separate, decrypt, sign in, scan, read, sending disabled), RPO and RTO `(met)`. Then terminate the instance and shred `~/keys`.

## Full-service recovery plan (host lost)

Each step's time is recorded in the report to measure the RTO.

1. Provision a replacement host. It must be isolated: not reachable at dazl.ai, with no DNS change yet.
2. Install Node 22 and the release at the same commit (`git checkout <sha>`, `npm ci`, `npm run build`).
3. Fetch the newest off-host copy, decrypt it with the `age` identity from its offline store, and check its sidecar.
4. Restore the env file from its secure store: master key, Stripe keys, webhook secret, OAuth clients. Restore the Caddyfile and the service unit from the repo (`ops/`) and from the owner's notes.
5. Run `replacement-drill.mts` (full mode; it runs `recovery-drill.mts --app`). The drill must pass before anything else.
6. **Re-apply tenant deletions (#359) before the store serves.** Fetch the newest tombstone ledger copy from the off-host destination (`dazl-ledger-<utc>.jsonl.age`, copied by `ops/backup/offhost-copy.sh` right after each backup copy; its manifest names the backup it went with) and decrypt it with the same `age` identity, or use the live `DAZL_TOMBSTONE_LEDGER` file if the host survived, whichever is newer, and run `DAZL_DB_PATH=<restored db> node --experimental-strip-types scripts/tenant-lifecycle.mts --reapply --ledger <file>` (dry run: prints the line count), then again with `--execute`. Any refused line is printed with its reason and the command exits 1: do not continue until each is resolved (docs/TENANT-LIFECYCLE.md, "Restored backups").
7. **Sending stays disabled.** Start the service with `AUTOPILOT_KILL=1` and no `AUTOPILOT_TICK_SECRET`. Reconcile every unresolved send from step 3 of the drill: an operator decides each uncertain message (`mark_sent` or `retry` in the app, `resolveUncertain`). Wait for every old lease to expire, which is at most 30 minutes for the tick lease. Then compare against the Gmail Sent folder of each connected account where the owner has access.
8. Switch Caddy and DNS to the new host. Check `/api/ready`, then run `node ops/release-manifest.mjs check release.json https://dazl.ai`.
9. Only when `send-gate.mts --db <live restored DB_PATH>` exits 0: remove `AUTOPILOT_KILL` and restore the tick secret.

## Postgres cutover (when authorized; docs/PLATFORM.md)

- The same targets apply. The backup becomes `pg_dump -Fc` (or a managed provider's point-in-time recovery).
- The drill's content step becomes `pg_restore` into a throwaway database plus row-count and content comparison.
- Steps 2 to 4 are unchanged once the app reads Postgres: decrypt every registered column, the send-safety counts, and the app started on the restored database.
- This needs a Postgres variant of `restoreDrill`, which is not built. Do it before the cutover, not after.
- What carries over unchanged: `offhost-copy.sh` (it encrypts any file; feed it the `pg_dump -Fc` output and its sidecar), `config-backup.mts` (add the Postgres connection settings to `CONFIG_FILES`; a `DATABASE_URL` password is a secret like any other in the bundle), `prune-backups.mts` (names and sidecars), `backup-check.mts` (freshness, ciphertext, config, key drill), the three-key separation and the send gate.
- What changes: `send-safety.mts` counts become SQL against Postgres (same tables and statuses); the replacement drill's step 4 restores with `pg_restore` into a throwaway database before starting the app with `DATABASE_URL` pointing at it.
- With a managed provider's point-in-time recovery, RPO drops to minutes, but the provider's snapshots are not off-account copies: keep the encrypted `pg_dump` off-host copy too, and keep the same drill.

## What Instinct or the owner must provision

| what | who | cost |
|---|---|---|
| Run `ops/backup-inventory.sh` on the host and attach the output | Instinct | free |
| The targets and retention above are set (Hermes decision under delegation); the owner may change them | owner (optional) | none |
| Store `DAZL_MASTER_KEY` in two offline places, separate from backups; name who can recover it | owner | free (password manager / paper) |
| A backup schedule on the host: install `ops/backup/dazl-backup.timer` and `dazl-backup-check.timer` | Instinct | free |
| An off-host destination for encrypted copies, from the options below | owner chooses, Instinct sets up | see the options |
| An `age` key pair for the off-host copies; the private key stored offline, separately from the master key | owner | free (`apt install age`) |
| An alert destination for stale or failed backups (`OPS_ALERT_WEBHOOK_URL`, for example a free Slack incoming webhook) | owner | free |
| A first isolated drill on the host, then a replacement-host drill, each report attached to #360 | Instinct | free on the existing host; a temporary replacement instance costs its hourly price for the hours it runs |

**Off-host destination.** Decision (Hermes, under delegation, 2026-11-03): Cloudflare R2 through rclone (`OFFHOST_DEST=rclone:r2:dazl-backups`), on the free tier (10 GB-month, no egress fees: the database with this retention stays far below it, so no spend). Instinct creates the bucket and a bucket-scoped token on the dazl Cloudflare account; if that account is not available, the next choice is Backblaze B2's free 10 GB, then S3 (paid, needs Gagan's approval). Nothing below is set up.

**Off-host options.** List prices change, so check before choosing.
- **Free:**
  - Cloudflare R2 free tier: 10 GB-month of storage, no egress fees.
  - Backblaze B2: first 10 GB free.
  - A second machine the owner already has, reached with rsync over SSH.
- **Low cost on the existing AWS account:**
  - S3 Standard: about $0.023 per GB-month. For a database of tens to hundreds of MB with the retention above, that is cents per month.
  - EBS snapshots through Data Lifecycle Manager: DLM itself is free, and snapshots are billed per GB-month of changed blocks.

  Either is a paid service, so the owner must approve it.
