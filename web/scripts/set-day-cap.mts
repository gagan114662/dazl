// Operator: set one workspace's daily AI spend cap. Not reachable from the web app.
//
//   cd web && node --experimental-strip-types scripts/set-day-cap.mts --env-file <run env file> --tenant <workspace id> --usd 5 [--write]
//
// Without --write it prints the change only (dry run). With --write it rewrites only the DAZL_RUN_MAX_USD_USERS line of
// the env file (a backup is written beside it as <file>.bak-<epoch>); restart the app so it reads the new value, then
// confirm with GET /api/internal/spend-caps?tenant=<workspace id> (source "account", the new usd).
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { setDayCap } from '../lib/ops/day-cap.ts'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined }
const file = arg('env-file'), tenant = arg('tenant'), usd = arg('usd')
if (!file || !tenant || !usd) { console.error('usage: --env-file <file> --tenant <workspace id> --usd <amount> [--write]'); process.exit(2) }
try {
  const r = setDayCap(readFileSync(file, 'utf8'), tenant, usd)
  console.log(JSON.stringify({ tenant, before: r.before, after: r.after, write: process.argv.includes('--write') }))
  if (process.argv.includes('--write')) {
    copyFileSync(file, `${file}.bak-${Math.floor(Date.now() / 1000)}`)
    writeFileSync(file, r.text, { mode: 0o600 })
    console.log('written; restart the app to apply')
  }
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1) }
