# Off-host production backup: two commands and a restore test (issue #1080)

The owner-approved plan (2026-11-23): every hour the production box takes a consistent snapshot of the database,
encrypts it with `age`, and uploads it to an S3 bucket in the existing dazl AWS account (`ca-central-1`). The box holds
a key that can only **add** and **list** copies. It cannot read one back and cannot delete one. The bucket deletes
copies after 30 days by itself.

Older, more detailed notes (the rclone and pull-over-ssh variants, retention numbers, the deletion ledger) are in
[`INSTALL.md`](INSTALL.md). For the approved plan, this page is all you need.

## Before you start

- This change must be **deployed to production** first: the box runs the live release's own backup scripts.
- On your Mac: the AWS CLI, signed in to the dazl AWS account (`aws sts get-caller-identity` shows it), and `age`
  (`brew install age`).

## Step 1: on your Mac — the bucket, the upload-only key, the encryption key

```bash
bash ops/backup/aws-setup.sh --dry-run     # optional: prints every AWS call it would make, makes none
bash ops/backup/aws-setup.sh               # asks once before it starts; bucket dazl-prod-backups-<account id>
```

A pass ends with `aws-setup: DONE.` after four numbered lines:

```
aws-setup: 1. age key pair: made ~/dazl-backup-keys/dazl-offhost-identity.txt (PRIVATE key, mode 600)
aws-setup: 2. bucket dazl-prod-backups-<id>: created in ca-central-1; public access blocked, encryption on, versioning on, 30-day lifecycle; all read back
aws-setup: 3. IAM user dazl-backup-writer: created; its one policy (dazl-backup-put-only) allows s3:PutObject on .../prod/* and s3:ListBucket on that prefix, nothing else
aws-setup: 4. access key AKIA...: made; its secret is in ~/dazl-backup-keys/dazl-prod-backups-<id>.s3.env (mode 600) and was not shown
```

Run it again any time: it changes nothing that is already right. It **refuses** (and changes nothing) when the bucket
already exists with other settings, belongs to another account, or the IAM user has any other permission; it says
which. The secret access key is never printed: it is only in the `.s3.env` file.

## Step 2: on the production box — install, back up now, check

Copy the one file over, then run the installer as root from a release that contains it:

```bash
scp ~/dazl-backup-keys/dazl-prod-backups-<id>.s3.env ubuntu@<the box>:/home/ubuntu/dazl-backup.s3.env
ssh ubuntu@<the box>
REL=$(for d in $(sed -n 's/^DAZL_RELEASE=//p' /etc/dazl-prod/ports/*.conf); do [ -f "$d/ops/backup/install-prod-offhost.sh" ] && echo "$d"; done | head -1)
sudo bash "$REL/ops/backup/install-prod-offhost.sh" --credentials /home/ubuntu/dazl-backup.s3.env --dry-run   # optional
sudo bash "$REL/ops/backup/install-prod-offhost.sh" --credentials /home/ubuntu/dazl-backup.s3.env
```

A pass is three `PASS` lines and `ALL PASS`:

```
PASS  backup now (timers installed; dazl-backup.service ran once)
PASS  freshness check: newest object in s3:dazl-prod-backups-<id>/prod is dazl-backup-<time>-<id>.db.age, 12s old (limit 7200s)
PASS  restore test: dazl-backup-<time>-<id>.db restored into a temporary file; PRAGMA integrity_check ok, N tables match (temporary copy removed)

install-prod-offhost: ALL PASS. Backups now run every hour and leave this box encrypted; the check runs every 15 minutes.
```

Any `FAIL` exits 1 with the reason above it; fix it and run the same command again. Then delete the copied file on the
box (`shred -u /home/ubuntu/dazl-backup.s3.env`); the key now lives in `/etc/dazl-backup/s3.env` (root and the app
user only).

What the restore test on the box does and does not prove: it restores **the snapshot that was just uploaded** into a
temporary file and checks it. It cannot decrypt the copy that is in the bucket, because the private key is not on the
box and the box's key cannot read the bucket. That is on purpose, and it is why step 3 exists.

## Step 3: on your Mac — restore from the bucket (the real proof, and how to restore)

```bash
bash ops/backup/restore-s3.sh --bucket dazl-prod-backups-<id> \
     --identity ~/dazl-backup-keys/dazl-offhost-identity.txt --out ~/dazl-restore-test
```

It downloads the newest encrypted copy, checks it against its manifest, decrypts it and opens it. A pass:

```
PASS  find: newest copy is dazl-backup-<time>-<id>.db.age (uploaded <time>)
PASS  check: <bytes> bytes, sha256 matches the manifest
PASS  decrypt: byte for byte the snapshot the box took
PASS  ledger: the deletion ledger copy decrypts (N line(s)); docs/RECOVERY.md step 6 re-applies it
PASS  verify: PRAGMA integrity_check ok; rows: users N, scan_jobs N, leads N

restore-s3: ALL PASS. The restored database is ~/dazl-restore-test/dazl-backup-<time>-<id>.db
```

That file is the database. After a drill, delete it (`rm -rf ~/dazl-restore-test`): it is a full copy of production.
In a real recovery it becomes the new `DB_PATH`; the rest of the procedure (the master key, re-applying deletions,
starting the app with sending disabled) is [`docs/RECOVERY.md`](../../docs/RECOVERY.md). The script only reads from the
bucket. Copies you already downloaded restore without AWS: `--from-dir <directory>` instead of `--bucket`.

## Where the two keys must be kept

Both **off the box and outside the bucket**. Without either one, the backups are useless.

| key | what it is | keep it |
|---|---|---|
| `~/dazl-backup-keys/dazl-offhost-identity.txt` | the `age` PRIVATE key: the only thing that can decrypt a backup | in the password manager, plus one offline copy (a printed page or a USB stick in a safe place). Never on the box, never in the bucket, never in this repository or an issue |
| `DAZL_MASTER_KEY` | the app's own key: it decrypts the mailbox tokens and API keys **inside** the database. It is not in any backup | in the password manager as a separate entry, plus one offline copy, in a different place from the `age` key |

Then write on issue #1080 **where** each one is kept and who can get at it (for example "1Password vault X, entry Y;
paper copy in Z"). Never the value.

## How you find out when it stops

The box checks itself every 15 minutes (`dazl-backup-check.timer`) and sends an alert to `OPS_ALERT_WEBHOOK_URL` (the
same destination as the uptime probe) when the newest local backup or the newest object in the bucket is older than
2 hours, when a copy is cut short, or when the hourly restore check fails. The installer takes that URL from the app's
run env; if it says `NO alert destination found`, add `OPS_ALERT_WEBHOOK_URL=...` to `/etc/dazl-backup/env`.

The uptime probe (`ops/uptime/probe.mjs`) is **not** wired to the backup age. It runs off the box and reads public URLs
only; to see the bucket it would need its own AWS key or a public endpoint that reports backup age, and neither is
cheap or clearly wanted. What it already covers: if the whole box is down (so the box's own check cannot alert), the
probe alerts that the site is down.

## What it costs

About **US$0.15 to US$0.30 a month** at today's database size (roughly 8 to 12 MB): 24 copies a day kept for 30 days is
6 to 9 GB of S3 Standard storage in `ca-central-1` (about US$0.025 per GB a month), plus a few cents of requests. It
grows in step with the database. `age` is free.

## What is where on the box

| path | what |
|---|---|
| `/etc/dazl-backup/env` | settings (`OFFHOST_DEST=s3:<bucket>/prod`, retention, the alert URL) |
| `/etc/dazl-backup/s3.env` | the upload-only AWS key (root and the app user only) |
| `/etc/dazl-backup/recipients.txt` | the `age` PUBLIC key |
| `/var/backups/dazl/` | the newest 48 local snapshots |
| `dazl-backup.timer`, `dazl-backup-check.timer` | hourly backup; 15-minute check. `journalctl -u dazl-backup -n 20` |

Rotating the AWS key: `bash ops/backup/aws-setup.sh --new-key` on the Mac, copy the file, run step 2 again, then delete
the old key (`aws iam delete-access-key --user-name dazl-backup-writer --access-key-id <old id>`).

## Not covered here

- The daily secrets/config bundle (`dazl-config-backup.timer`) does not work with the upload-only key (it reads back
  what it uploaded). The production env file is therefore **not** in the bucket: keep a copy of it with the keys above.
- Nothing in this directory has been run against AWS or the production box by the people who wrote it. The first run of
  the three steps above is the proof.
