#!/usr/bin/env bash
# Backup inventory for the dazl host (issue #360; docs/RECOVERY.md "Step 1: inventory"). READ-ONLY and metadata only:
# it lists what backs the service up today without reading a database, a backup's contents, an env file or any secret.
# Output: one JSON object on stdout. Run on the host by Instinct (root not required for most checks; without root some
# schedules are not visible and say so):
#   bash ops/backup-inventory.sh --db /path/to/app.db [--backup-dir /var/backups/dazl ...] > inventory.json
# Reports:
#   - the live database file: size, age of last write, WAL size (stat only; never opened)
#   - local backups in each --backup-dir: count, newest/oldest age, total bytes, how many have a .json sidecar
#   - schedules that mention a backup: crontab lines and systemd timers whose name or command mentions backup, sqlite,
#     dazl, rsync, rclone, restic, borg, snapshot (the matching unit/command names, no environment)
#   - off-host tools present: aws, rclone, restic, borg, age, gpg (presence only)
#   - AWS, when the aws CLI and instance credentials work: this instance's EBS volumes, the newest snapshot of each and
#     snapshot counts, Data Lifecycle Manager policies and AWS Backup plans (ids, names, schedules; metadata only)
# INVENTORY_SKIP_AWS=1 skips the AWS calls (tests).
set -uo pipefail
DB=; DIRS=()
while [ $# -gt 0 ]; do case "$1" in
  --db) DB=$2; shift 2 ;;
  --backup-dir) DIRS+=("$2"); shift 2 ;;
  *) echo "usage: backup-inventory.sh --db PATH [--backup-dir DIR ...]" >&2; exit 2 ;;
esac; done
[ ${#DIRS[@]} -gt 0 ] || DIRS=(/var/backups/dazl)
now=$(date +%s)
q() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t' '  '; } # JSON string body
age() { [ -e "$1" ] && echo $(( now - $(stat -c %Y -- "$1") )) || echo null; }
size() { [ -e "$1" ] && stat -c %s -- "$1" || echo null; }

db_json='null'
if [ -n "$DB" ]; then
  db_json=$(printf '{"path":"%s","exists":%s,"bytes":%s,"last_write_age_s":%s,"wal_bytes":%s}' "$(q "$DB")" "$([ -e "$DB" ] && echo true || echo false)" "$(size "$DB")" "$(age "$DB")" "$(size "$DB-wal")")
fi

dirs_json=''
for d in "${DIRS[@]}"; do
  if [ -d "$d" ]; then
    mapfile -t files < <(find "$d" -maxdepth 1 -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.age' -o -name '*.gpg' -o -name '*.gz' -o -name '*.zst' \) -printf '%T@ %s %p\n' 2>/dev/null | sort -n)
    n=${#files[@]}; bytes=0; sidecars=0; newest=null; oldest=null
    for f in "${files[@]}"; do set -- $f; bytes=$(( bytes + $2 )); [ -e "$3.json" ] && sidecars=$(( sidecars + 1 )); done
    if [ "$n" -gt 0 ]; then
      oldest=$(( now - ${files[0]%%.*} )); last=${files[$((n-1))]}; newest=$(( now - ${last%%.*} ))
    fi
    dirs_json+=$(printf '%s{"dir":"%s","exists":true,"files":%s,"bytes":%s,"with_sidecar":%s,"newest_age_s":%s,"oldest_age_s":%s}' "${dirs_json:+,}" "$(q "$d")" "$n" "$bytes" "$sidecars" "$newest" "$oldest")
  else
    dirs_json+=$(printf '%s{"dir":"%s","exists":false}' "${dirs_json:+,}" "$(q "$d")")
  fi
done

PAT='backup|sqlite|dazl|rsync|rclone|restic|borg|snapshot'
found=$(mktemp); trap 'rm -f "$found"' EXIT
sched=''
add() { sched+=$(printf '%s"%s"' "${sched:+,}" "$(q "$1")"); }
for c in /etc/crontab /etc/cron.d/*; do [ -r "$c" ] && grep -hEi "$PAT" "$c" 2>/dev/null | grep -v '^\s*#' | while read -r l; do echo "cron $c: $(echo "$l" | awk '{for(i=6;i<=NF;i++) printf "%s ", $i}')"; done; done > "$found" 2>/dev/null
for f in /etc/cron.hourly/* /etc/cron.daily/* /etc/cron.weekly/*; do [ -e "$f" ] && echo "$f" | grep -Eqi "$PAT" && echo "cron script: $f"; done >> "$found"
crontab -l 2>/dev/null | grep -Ei "$PAT" | grep -v '^\s*#' | sed 's/^/user crontab: /' >> "$found"
if command -v systemctl >/dev/null 2>&1; then systemctl list-timers --all --no-legend 2>/dev/null | grep -Ei "$PAT" | awk '{print "systemd timer: " $(NF-1) " -> " $NF}' >> "$found"; fi
while read -r l; do add "$l"; done < "$found"
cron_visible=$([ -r /etc/crontab ] && echo true || echo false)

tools=''
for t in aws rclone restic borg age gpg sqlite3; do tools+=$(printf '%s"%s":%s' "${tools:+,}" "$t" "$(command -v "$t" >/dev/null 2>&1 && echo true || echo false)"); done

aws_json='{"checked":false}'
if [ "${INVENTORY_SKIP_AWS:-}" != 1 ] && command -v aws >/dev/null 2>&1; then
  tok=$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)
  iid=$( [ -n "$tok" ] && curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)
  region=$( [ -n "$tok" ] && curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)
  if [ -n "$iid" ]; then
    export AWS_DEFAULT_REGION=$region
    vols=$(aws ec2 describe-volumes --filters "Name=attachment.instance-id,Values=$iid" --query 'Volumes[].VolumeId' --output text 2>&1) || vols="ERROR: $vols"
    vj=''
    if [[ "$vols" != ERROR* ]]; then for v in $vols; do
      snaps=$(aws ec2 describe-snapshots --owner-ids self --filters "Name=volume-id,Values=$v" --query 'length(Snapshots)' --output text 2>/dev/null || echo null)
      newest=$(aws ec2 describe-snapshots --owner-ids self --filters "Name=volume-id,Values=$v" --query 'sort_by(Snapshots,&StartTime)[-1].StartTime' --output text 2>/dev/null || echo None)
      vj+=$(printf '%s{"volume":"%s","snapshots":%s,"newest_snapshot":"%s"}' "${vj:+,}" "$v" "${snaps:-null}" "$(q "$newest")")
    done; fi
    dlm=$(aws dlm get-lifecycle-policies --query 'Policies[].[PolicyId,State,Description]' --output text 2>&1 | head -20)
    plans=$(aws backup list-backup-plans --query 'BackupPlansList[].[BackupPlanName,BackupPlanId]' --output text 2>&1 | head -20)
    aws_json=$(printf '{"checked":true,"instance":"%s","region":"%s","volumes_error":%s,"volumes":[%s],"dlm_policies":"%s","backup_plans":"%s"}' "$iid" "$region" "$([[ "$vols" == ERROR* ]] && printf '"%s"' "$(q "$vols")" || echo null)" "$vj" "$(q "$dlm")" "$(q "$plans")")
  else aws_json='{"checked":false,"reason":"no EC2 instance metadata (not on EC2, or IMDS blocked)"}'; fi
fi

printf '{"kind":"dazl backup inventory","at":"%s","host":"%s","db":%s,"backup_dirs":[%s],"schedules":[%s],"cron_readable":%s,"tools":{%s},"aws":%s}\n' \
  "$(date -u +%FT%TZ)" "$(q "$(hostname -s 2>/dev/null || echo unknown)")" "$db_json" "$dirs_json" "$sched" "$cron_visible" "$tools" "$aws_json"
