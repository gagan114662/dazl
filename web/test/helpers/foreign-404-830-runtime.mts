import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateWarm } from '../../lib/warm/connections.ts'
import { AUDIT_DDL } from '../../lib/audit.ts'
import { GET as exportGET } from '../../app/api/leads/export/route.ts'
import { GET as warmGET } from '../../app/api/leads/[lead]/warm-path/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const get = (path: string) => new NextRequest(`http://localhost${path}`, { method: 'GET' })
const hex = () => randomBytes(12).toString('hex')

function build() {
  const db = new Database(':memory:')
  for (const m of [migrateScan, migrateWarm]) m(db)
  db.exec(AUDIT_DDL)
  setScanDb(db)
  const seed = (t: string, co: string) => {
    const job = createJob(db, t, { business_name: t, industry: 'test', location: 'test' })
    db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
    const lead = hex()
    db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,score) VALUES(?,?,?,'Pat','p@x.invalid','Hiring','https://x.invalid/jobs','ev',80,1,70)").run(lead, job, co)
    return { job, lead }
  }
  return { db, a: seed('A', 'AMARK830CO'), b: seed('B', 'BMARK830CO') }
}

test('#830 B reading A\'s lead warm-path or A\'s job export gets 404, no allowed export audit; owners still get 200', async () => {
  const { db, a, b } = build()
  setUser({ id: 'B', business_name: 'Beta' })
  const w = await warmGET(get(`/api/leads/${a.lead}/warm-path`), { params: Promise.resolve({ lead: a.lead }) })
  assert.equal(w.status, 404, 'warm-path foreign lead')
  const e = await exportGET(get(`/api/leads/export?job_id=${a.job}`))
  assert.equal(e.status, 404, 'export foreign job')
  const allowed = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id='B' AND action='export.leads' AND decision='allowed'").get() as { n: number }
  assert.equal(allowed.n, 0, 'no allowed export audit for a foreign job')
  // Owner controls
  assert.equal((await warmGET(get(`/api/leads/${b.lead}/warm-path`), { params: Promise.resolve({ lead: b.lead }) })).status, 200)
  const own = await exportGET(get(`/api/leads/export?job_id=${b.job}`))
  assert.equal(own.status, 200)
  assert.match(await own.text(), /BMARK830CO/)
  setUser({ id: 'A', business_name: 'Acme' })
  assert.equal((await warmGET(get(`/api/leads/${a.lead}/warm-path`), { params: Promise.resolve({ lead: a.lead }) })).status, 200)
  assert.match(await (await exportGET(get(`/api/leads/export?job_id=${a.job}`))).text(), /AMARK830CO/)
})
