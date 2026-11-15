# Installing the production backup (issue #1080)

Everything the backup needs was already in the repository (`run-backup.sh`, `offhost-copy.sh`, `backup-check.mts`, the
restore drills) but nothing installed it, and the unit templates named a release directory, which moves on every deploy.
`install-prod.sh` installs it in one command; the units run `/usr/local/lib/dazl-backup/prod-run.sh`, which asks
`live-release.sh` which release Caddy serves and runs **that release's own** backup and check.

Who runs this: Hermes, on the box, from the live release's checkout (never a hand edit under `/etc/systemd`).

## 0. Once: the off-host destination and the keys (free)

| what | how | cost |
|---|---|---|
| destination | an S3 bucket on the AWS account the box already runs in, reached with the instance's own role (no key on disk) | S3 free tier: 5 GB for 12 months. The database is about 3.7 MB; with retention ON (the default) 48 hourly + 14 daily + 8 weekly copies are about 260 MB: under US$0.01 a month after the free tier. With `--no-retention` it grows about 88 MB a day (about 2.7 GB a month) without limit |
| encryption | `age` (open source). Only ciphertext leaves the box | free |
| copy tool | `rclone` (open source) | free |

```bash
sudo apt-get install -y age rclone        # on the box
# The three `aws` commands below run where the AWS CLI and an admin profile are (the operator's machine or CloudShell),
# NOT on the box: the box has no aws CLI and needs none.
# the bucket (private, versioned so an overwritten or deleted copy can be recovered)
aws s3api create-bucket --bucket <bucket> --region <region> --create-bucket-configuration LocationConstraint=<region>
aws s3api put-public-access-block --bucket <bucket> --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket <bucket> --versioning-configuration Status=Enabled
# the instance role gets ONLY this. s3:DeleteObject is for retention (on by default): it deletes copies beyond
# 48 hourly + 14 daily + 8 weekly; the bucket is versioned, so a wrong delete is recoverable. With --no-retention
# leave DeleteObject out.
#   {"Version":"2012-10-17","Statement":[
#     {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::<bucket>/prod/*"},
#     {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::<bucket>","Condition":{"StringLike":{"s3:prefix":["prod/*"]}}}]}
# as the app user (ubuntu): a remote that uses the instance role
rclone config create dazl-s3 s3 provider AWS env_auth true region <region> no_check_bucket true
```

The data key pair, made **off the box** (the operator's own machine), so the box can write copies it cannot read back:

```bash
age-keygen -o dazl-data-identity.txt          # PRIVATE: keep offline (password manager + a sealed copy). Never on the box,
                                              # never next to DAZL_MASTER_KEY, never in this repository or an issue.
grep -o 'age1[0-9a-z]*' dazl-data-identity.txt # PUBLIC: this one line goes to the box:
sudo install -d -m 750 -g ubuntu /etc/dazl-backup && echo 'age1...' | sudo tee /etc/dazl-backup/recipients.txt
```

`DAZL_MASTER_KEY` escrow (acceptance 3) is the owner's: two places other than the box, apart from the age identity.
Record on the issue **where**, never the value. A restored database opens without it; the secrets stored inside it do not.

## 1. Install (root, on the box)

```bash
cd "$(bash ops/backup/live-release.sh)"        # the live release's checkout
sudo bash ops/backup/install-prod.sh --offhost rclone:dazl-s3:<bucket>/prod --alert-url <https webhook>
```

It checks first (user, database, node on the app user's default PATH, age, rclone, public keys only), writes
`/etc/dazl-backup/env` only when there is none, installs the four units, enables both timers and runs the first backup
before it returns. An existing env file that differs from the options given STOPS the install and names the differing
settings (so `--offhost` is never silently ignored); `--keep-env` installs with the file as it is. An existing backup
directory is left as it is (never re-owned); a system directory (`/`, `/var/lib`, ...) is refused.

**Retention is ON from the install** (`BACKUP_RETENTION=1`; the numbers are the decided ones: 48 local hourly copies;
off-host 48 hourly + 14 daily + 8 weekly). There is no later step to turn it on: this replaces "set BACKUP_RETENTION=1
after the first verified off-host cycle" in the older runbook, and it is safe from the first run because the prune
refuses to delete anything while the newest backup, its restore check or its off-host copy is in doubt. The installer
refuses when the disk cannot hold the 48 copies twice over. `--no-retention` installs with nothing ever deleted: the
installer then prints how many days the disk lasts and refuses under 7 days. Either way the 15-minute check alerts when
the backup directory's filesystem has under 1024 MB free (`BACKUP_MIN_FREE_MB`), and, with retention off, when it would
be full in under 14 days (`BACKUP_MIN_DAYS_LEFT`).

**The deletion ledger.** The off-host copy also ships the app's tombstone ledger (`DAZL_TOMBSTONE_LEDGER`, #359). The
installer reads that path from the app's run env (`--app-env`, default `/home/ubuntu/dazl-pr16-run.env`, read as data)
so it copies the file the app really writes. When the app's env sets none it installs on
`/var/lib/dazl-ledger/tombstones.jsonl` and prints a WARNING: add `DAZL_TOMBSTONE_LEDGER=/var/lib/dazl-ledger/tombstones.jsonl`
to the app's run env and deploy, otherwise the app cannot ledger a tenant deletion and the copied ledger is only an empty file.

Run the installer from a checkout of a reviewed commit (the live release is one: `deploy-prod.sh` clones the deployed
commit). It runs as root, so do not run it from a directory someone else has edited. Without `--offhost` it
installs local backups only and says so in capitals; without `--alert-url` alerts go to the journal only (#1088 wires the
destination).

## 2. Verify live

```bash
sudo bash ops/backup/install-prod.sh --status          # installed = this checkout; both timers with their next run
systemctl list-timers | grep dazl-backup
journalctl -u dazl-backup -n 5 --no-pager              # {"type":"backup","ok":true,...,"offhost":true}
rclone lsl dazl-s3:<bucket>/prod | tail -4             # an object less than 1 h old
sudo -u ubuntu bash -c 'set -a; . /etc/dazl-backup/env; bash /usr/local/lib/dazl-backup/prod-run.sh check'   # "ok":true
```

## 3. Prove a restore (acceptance 4)

On a scratch host or directory that has the PRIVATE identity (not the box). It needs READ access to the bucket: the
box's role is not there, so give the scratch host its own read-only credentials (`s3:GetObject` on `prod/*` and
`s3:ListBucket`), e.g. an operator profile with `rclone config create dazl-s3 s3 provider AWS env_auth true region <region>`:

```bash
bash ops/backup/restore-offhost.sh --offhost rclone:dazl-s3:<bucket>/prod --identity dazl-data-identity.txt --out /var/tmp/dazl-restore-$(date -u +%Y%m%dT%H%M%SZ)
```

One JSON line: the restored file, `rpo_s` (what losing the box at that moment would have lost), `restore_ms`,
`integrity: ok` and the row counts of `users`, `scan_jobs` and `leads`. A damaged or foreign manifest at the destination
is named in a WARNING and skipped (then an older copy may be the one restored: read `rpo_s`); a failed restore leaves no
decrypted file behind. Compare them with production's, read-only, on the box. The box has no `sqlite3` CLI, so use node from the live release:

```bash
cd "$(bash ops/backup/live-release.sh)/web" && node -e 'const d=require("better-sqlite3")("/home/ubuntu/dazl-data/dazl-pr16.db",{readonly:true});for(const t of ["users","scan_jobs","leads"])console.log(t,d.prepare("select count(*) n from "+t).get().n)'
```

(`restore-offhost.sh` itself needs `sqlite3` on the scratch host: `apt-get install -y sqlite3 age rclone`.)
Starting the app on the copy with sending disabled is `scripts/backup/replacement-drill.mts` (docs/RECOVERY.md).
Delete the restored copy afterwards: it is a full copy of production.

## 4. The alert (acceptance 5)

`dazl-backup-check.timer` runs every 15 minutes and alerts when the newest local backup, the newest off-host copy or
the last restore check is older than 2 hours, or failed. To see it fire without waiting, on the box:

```bash
sudo -u ubuntu bash -c 'set -a; . /etc/dazl-backup/env; BACKUP_MAX_AGE_S=1 bash /usr/local/lib/dazl-backup/prod-run.sh check'   # exit 1 and one alert
```

## Removing it

`sudo bash ops/backup/install-prod.sh --uninstall` stops the timers and removes the units and the installed scripts.
`/etc/dazl-backup` and every backup stay.

## Not installed by this script (later, each needs its own keys)

The secrets/config bundle (`dazl-config-backup.timer`, its own age recipients) and the quarterly key drill.
`CONFIG_REQUIRED` and `KEY_DRILL_REQUIRED` are written as 0, so the check does not alert for them.
