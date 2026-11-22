J=679a7354658121281c331e61; D=$(ls -d /home/ubuntu/dazl-ff25534b*-prod | head -1)/web; echo "RELEASE $D"
P=$(sudo ss -ltnp 2>/dev/null | grep ':3105 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); E=$(sudo cat /proc/$P/environ | tr '\0' '\n')
echo "DB_KEYS: $(echo "$E" | grep -iE '^[A-Z_]*(DB|DATABASE|SQLITE)[A-Z_]*=' | cut -d= -f1 | tr '\n' ' ')"
F=$(echo "$E" | grep -iE '^[A-Z_]*(DB|DATABASE|SQLITE)[A-Z_]*=' | cut -d= -f2- | grep -oE '(file:)?/[^ ?]+\.(db|sqlite)' | sed 's/^file://' | head -1); echo "DB_FILE $F"
[ -z "$F" ] && { echo "NO_SQLITE_FILE"; exit 0; }
sudo python3 - "$F" "$J" > /tmp/r1517.json <<'PY'
import sqlite3,sys,json
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True); c.row_factory=sqlite3.Row
r=c.execute("select id,status,spend_reserved_usd,spend_cap_reserved_usd from scan_jobs where id=?",(sys.argv[2],)).fetchone()
o=dict(r) if r else {"missing":True}
try: o["ledger_sum_scan_spend_calls"]=c.execute("select round(sum(coalesce(settled_usd,reserved_usd)),4) from scan_spend_calls where job_id=?",(sys.argv[2],)).fetchone()[0]
except Exception as e: o["ledger_err"]=str(e)[:120]
print(json.dumps(o))
PY
cat /tmp/r1517.json
cat > /tmp/r1517.mts <<'TS'
import { readFileSync } from 'node:fs'
const r = JSON.parse(readFileSync('/tmp/r1517.json','utf8'))
const { recordedJobCostUsd } = await import(process.argv[2] + '/lib/scan/job-cost.ts')
const old = Number(r.spend_reserved_usd ?? 0) + Number(r.spend_cap_reserved_usd ?? 0)
console.log(JSON.stringify({ deployed_recordedJobCostUsd: recordedJobCostUsd(r.spend_reserved_usd, r.spend_cap_reserved_usd), prefix_history_formula_run_plus_cap: Math.round(old*10000)/10000 }))
TS
(cd $D && node --experimental-strip-types --no-warnings /tmp/r1517.mts $D); rm -f /tmp/r1517.json /tmp/r1517.mts; echo DONE1517
