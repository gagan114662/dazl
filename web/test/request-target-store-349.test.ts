import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { createQueryJob, queryJobStep } from '../lib/scan/store-db.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'

const tenant = 'a'.repeat(32)
const query = 'Independent design studios in Helsinki opening a second office'
const icp = JSON.stringify({ summary: query, who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })

bothEngines('request target provenance survives both query-store entrypoints without promoting review', async ({ db }) => {
  const direct = await createQueryJob(db, tenant, { query, icp, icpFromQuery: true })
  const stepped = await db.tx(function* (tx) {
    return yield* queryJobStep(tx, tenant, { query, icp, icpFromQuery: true })
  })
  for (const id of [direct, stepped]) {
    const row = await db.get<{ icp: string; icp_inferred: number }>('SELECT icp, icp_inferred FROM scan_jobs WHERE id=? AND user_id=?', [id, tenant])
    assert.deepEqual(row, { icp, icp_inferred: 2 })
  }
})

bothEngines('polling a retained reviewed play preserves review authority and tenant scope', async ({ db }) => {
  const retained = await createQueryJob(db, tenant, { query, icp, icpRetained: true })
  const shown = await readScanStatus(db, tenant, retained)
  assert.equal(shown?.icp_source, 'user', 'retained explicit review must survive status polling')
  assert.deepEqual(shown?.icp, JSON.parse(icp))
  assert.equal(await readScanStatus(db, 'b'.repeat(32), retained), undefined)
  const fresh = await createQueryJob(db, tenant, { query, icp, icpFromQuery: true })
  assert.equal((await readScanStatus(db, tenant, fresh))?.icp_source, 'request_only')
  const carried = await createQueryJob(db, tenant, { query, icp })
  assert.equal((await readScanStatus(db, tenant, carried))?.icp_source, 'carried')
})
