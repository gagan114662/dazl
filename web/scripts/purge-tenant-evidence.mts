// Operator tool: honour a tenant's deletion request for copied page evidence (lead_evidence_copies). Not reachable from the web app.
// DRY RUN by default (prints counts, changes nothing). Executing writes an append-only audit row.
//
//   cd web && DAZL_DB_PATH=<sqlite file> node --experimental-strip-types scripts/purge-tenant-evidence.mts \
//     --tenant <tenant id> --confirm <tenant id again> --operator "<your name>" --reason "<ticket / written request, 10+ chars>" [--execute]
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { purgeTenantEvidence } from '../lib/scan/evidence-copies.ts'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined }
const file = process.env.DAZL_DB_PATH
if (!file) { console.error('DAZL_DB_PATH (the sqlite file) is required'); process.exit(2) }
const db = new Database(file); migrateScan(db)
try {
  const r = purgeTenantEvidence(db, { tenantId: arg('tenant') ?? '', confirmTenantId: arg('confirm') ?? '', operator: arg('operator') ?? '', reason: arg('reason') ?? '', execute: process.argv.includes('--execute') })
  console.log(JSON.stringify(r)); if (r.dryRun) console.log('dry run: nothing deleted. Re-run with --execute to delete.')
} catch (e) { console.error(e instanceof Error ? e.message : 'failed'); process.exit(1) } finally { db.close() }
