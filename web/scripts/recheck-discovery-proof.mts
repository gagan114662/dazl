// Use the configured DB_PATH or DATABASE_URL. With no --execute, report counts without writing lead holds.
import { parseArgs } from 'node:util'
import { getDb } from '../lib/db/client.ts'
import { recheckDiscoveryProof } from '../lib/proof-backfill.ts'

const { values } = parseArgs({ options: {
  tenant: { type: 'string' }, 'all-tenants': { type: 'boolean' }, execute: { type: 'boolean' },
} })
const tenant = values.tenant?.trim()
const allTenants = values['all-tenants'] === true
if (!!tenant === allTenants || (!process.env.DB_PATH && !process.env.DATABASE_URL)) {
  console.error('Pass either --tenant <workspace-id> or --all-tenants and set DB_PATH or DATABASE_URL.')
  process.exit(2)
}

const db = await getDb()
try {
  const execute = values.execute === true
  const workspaces = tenant ? [{ user_id: tenant }] : await db.all<{ user_id: string }>(
    `SELECT DISTINCT j.user_id FROM scan_jobs j JOIN leads l ON l.scan_job_id = j.id
     WHERE j.status = 'done' AND l.source_kind = 'discover' AND l.quarantined_at IS NULL AND l.evidence_purged_at IS NULL`,
  )
  const total = { checked: 0, quarantined: 0, blocked: 0, unnamed: 0 }
  for (const workspace of workspaces) {
    const counts = await recheckDiscoveryProof(db, { tenantId: workspace.user_id, execute })
    for (const key of ['checked', 'quarantined', 'blocked', 'unnamed'] as const) total[key] += counts[key]
  }
  console.log(JSON.stringify({ dryRun: !execute, ...total }))
} catch {
  console.error('Discovery proof recheck stopped. It is safe to run again.')
  process.exitCode = 1
} finally {
  await db.close()
}
