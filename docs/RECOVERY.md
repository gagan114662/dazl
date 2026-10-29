# Recovery: backups, targets and the restore drill (issue #360)

This document says what is known, proposes targets for the owner to approve, gives the isolated restore plan, and lists exactly what Instinct or the owner must provision. Nothing here has been run on the production host, and no off-host backup is set up by this change.

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

## Proposed targets (for the owner to approve; not agreed)

| target | proposal | why |
|---|---|---|
| RPO, data loss on host or disk loss | **1 hour** | hourly online backup plus an hourly encrypted off-host copy. The database is small, so a backup takes milliseconds to seconds. |
| RTO, database corrupted or a bad release on a working host | **30 minutes** | restore the newest passing backup in place (backup-runbook.md "Actually recovering"). The drill measures the software part. |
| RTO, host lost | **4 hours** | provision a replacement host, install the release, fetch and decrypt the off-host copy, restore secrets and config, start, check, switch DNS or Caddy. Dominated by provisioning. |
| Retention, local | 48 hourly | at least two days of fine-grained points on the box |
| Retention, off-host | 14 daily plus 8 weekly | about two months of history. Deletion is policy; #359 ties backup expiry to tenant deletion. |
| Backup alert | newest good backup older than 2 hours, newest off-host copy older than 2 hours, or the last drill failed or is more than 8 days old | `backup-check.mts`, every 15 minutes |
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
2. checks it restores faithfully with `restore-drill.ts`, and fails the run otherwise;
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
- the newest off-host copy is too old (`--offhost-dir`, a mounted view of the destination);
- the last recovery drill report failed or is too old.

Alerts go to `OPS_ALERT_WEBHOOK_URL` (https). The same problems alert at most once an hour. Alerts carry problems and ages, never data.

**Retention is not implemented.** Deleting backups is a policy decision (see the proposed targets). Until the owner sets it, backups accumulate, and the disk alert is the backstop.

**Install (Instinct, after approval):**
1. Copy `ops/backup/*.service` and `*.timer` to `/etc/systemd/system/` and replace the `CHANGE-ME` user and paths.
2. Create `/etc/dazl-backup/env` and `recipients.txt` (public key).
3. Run `rclone config` as the app user if using rclone.
4. Run `systemctl daemon-reload && systemctl enable --now dazl-backup.timer dazl-backup-check.timer`.
5. Check with `systemctl start dazl-backup.service && journalctl -u dazl-backup -n 20`.

## Full-service recovery plan (host lost)

Each step's time is recorded in the report to measure the RTO.

1. Provision a replacement host. It must be isolated: not reachable at dazl.ai, with no DNS change yet.
2. Install Node 22 and the release at the same commit (`git checkout <sha>`, `npm ci`, `npm run build`).
3. Fetch the newest off-host copy, decrypt it with the `age` identity from its offline store, and check its sidecar.
4. Restore the env file from its secure store: master key, Stripe keys, webhook secret, OAuth clients. Restore the Caddyfile and the service unit from the repo (`ops/`) and from the owner's notes.
5. Run `recovery-drill.mts` with `--app`. The drill must pass before anything else.
6. **Sending stays disabled.** Start the service with `AUTOPILOT_KILL=1` and no `AUTOPILOT_TICK_SECRET`. Reconcile every unresolved send from step 3 of the drill: an operator decides each uncertain message (`mark_sent` or `retry` in the app, `resolveUncertain`). Wait for every old lease to expire, which is at most 30 minutes for the tick lease. Then compare against the Gmail Sent folder of each connected account where the owner has access.
7. Switch Caddy and DNS to the new host. Check `/api/ready`, then run `node ops/release-manifest.mjs check release.json https://dazl.ai`.
8. Only then remove `AUTOPILOT_KILL` and restore the tick secret.

## Postgres cutover (when authorized; docs/PLATFORM.md)

- The same targets apply. The backup becomes `pg_dump -Fc` (or a managed provider's point-in-time recovery).
- The drill's content step becomes `pg_restore` into a throwaway database plus row-count and content comparison.
- Steps 2 to 4 are unchanged once the app reads Postgres: decrypt every registered column, the send-safety counts, and the app started on the restored database.
- This needs a Postgres variant of `restoreDrill`, which is not built. Do it before the cutover, not after.

## What Instinct or the owner must provision

| what | who | cost |
|---|---|---|
| Run `ops/backup-inventory.sh` on the host and attach the output | Instinct | free |
| Approve the RPO, RTO and retention targets above, or set others | owner | none |
| Store `DAZL_MASTER_KEY` in two offline places, separate from backups; name who can recover it | owner | free (password manager / paper) |
| A backup schedule on the host: install `ops/backup/dazl-backup.timer` and `dazl-backup-check.timer` | Instinct | free |
| An off-host destination for encrypted copies, from the options below | owner chooses, Instinct sets up | see the options |
| An `age` key pair for the off-host copies; the private key stored offline, separately from the master key | owner | free (`apt install age`) |
| An alert destination for stale or failed backups (`OPS_ALERT_WEBHOOK_URL`, for example a free Slack incoming webhook) | owner | free |
| A first isolated drill on the host, then a replacement-host drill, each report attached to #360 | Instinct | free on the existing host; a temporary replacement instance costs its hourly price for the hours it runs |

**Off-host options.** List prices change, so check before choosing. None is set up.
- **Free:**
  - Cloudflare R2 free tier: 10 GB-month of storage, no egress fees.
  - Backblaze B2: first 10 GB free.
  - A second machine the owner already has, reached with rsync over SSH.
- **Low cost on the existing AWS account:**
  - S3 Standard: about $0.023 per GB-month. For a database of tens to hundreds of MB with the retention above, that is cents per month.
  - EBS snapshots through Data Lifecycle Manager: DLM itself is free, and snapshots are billed per GB-month of changed blocks.

  Either is a paid service, so the owner must approve it.
