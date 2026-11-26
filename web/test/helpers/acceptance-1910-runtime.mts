// #1910 acceptance runtime: prod job 0e6a919e's Austin rows through homeReady (the readiness and hold
// pipeline Home's Ready tile and the Leads page share). Runs in a child process with the scan-route loader
// (the '@/lib' alias), like the #1040/#1831 runtimes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { homeReady } from '../../lib/outreach/home-ready.ts'
import { seedAustinJob } from '../fixtures/austin-0e6a919e.ts'

const NOW = Math.floor(Date.now() / 1000)

async function judged() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  seedAustinJob(db, 'A', NOW)
  return homeReady('A', NOW)
}

test('#1910 acceptance: the Austin rows currently give 0 Ready, each lead held for the reason the pipeline records', async () => {
  const r = await judged()
  assert.equal(r.ready, 0, 'no Austin lead is Ready today')
  assert.equal(r.judged, 3, 'all three leads are judged')
  const byCompany = new Map(r.companies.map(c => [c.company, c]))
  for (const name of ['Resplendent Agency', 'Zilker Media', 'DIGI Search']) {
    const c = byCompany.get(name)
    assert.ok(c, `${name} is judged`)
    assert.equal(c.ready, false, `${name} is held`)
    // The pipeline's current reason for every row: each carries review_reason source_review_required in prod
    // (Indeed 401, ZipRecruiter 403, Resplendent's paraphrased quote), which the hold pipeline reports as
    // 'needs your review'. S1/S2/S3 change the rows' inputs; this pin is the before picture.
    assert.equal(c.reason, 'needs your review', `${name}'s current hold reason`)
  }
})

test('#1910 acceptance target: at least one Austin lead is Ready', { todo: 'expected to fail until the S1, S2 and S3 fixes land (#1910)' }, async () => {
  const r = await judged()
  assert.ok(r.ready >= 1, `expected at least 1 Ready, got ${r.ready}`)
})
