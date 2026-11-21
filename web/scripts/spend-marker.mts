// Operator: inspect and resolve a stuck pending spend marker WITH EVIDENCE. Not reachable from the web app.
//
//   cd web && DAZL_DB_PATH=<sqlite file> node --experimental-strip-types scripts/spend-marker.mts --tenant <workspace id>
//   ... --tenant <id> --resolve p:<id> --reason "<what you checked>" --execute
//
// Read-first: without --resolve it only prints every pending marker with its age, the call it belongs to and that
// call's scan job. --resolve refuses unless the call is found and its job is finished; it keeps the full worst-case
// dollars counted (marker -> 'r:<id>', call -> 'kept' with your reason). Without --execute it prints what it would do.
// Each resolution is appended to <db file>.marker-resolutions.log. Take a backup of the database first; then run the deploy health check.
import Database from 'better-sqlite3'
import { markerEvidence, resolveMarker } from '../lib/ops/spend-marker.ts'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined }
const file = process.env.DAZL_DB_PATH, tenant = arg('tenant'), period = arg('resolve'), reason = arg('reason') ?? ''
if (!file || !tenant) { console.error('DAZL_DB_PATH and --tenant are required'); process.exit(2) }
const db = new Database(file, { fileMustExist: true })
const now = Math.floor(Date.now() / 1000)
try {
  if (!period || !process.argv.includes('--execute')) {
    console.log(JSON.stringify(markerEvidence(db, tenant, now), null, 2))
    if (period) console.log(`dry run: would resolve ${period} only if it is marked resolvable above; add --execute`)
    process.exit(0)
  }
  console.log(JSON.stringify({ resolved: resolveMarker(db, tenant, period, reason, now, `${file}.marker-resolutions.log`) }, null, 2))
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1) } finally { db.close() }
