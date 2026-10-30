import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateFeedback } from '../../lib/scan/feedback.ts'
import { POST, DELETE } from '../../app/api/leads/[lead]/quarantine/route.ts'

// The REAL quarantine route with the structured reason (#385): validated BEFORE any mutation, learned from, reverted on release, tenant-isolated. In-memory DB, no network.
globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const hex = () => randomBytes(12).toString('hex')
let n = 0
const req = (method: string, body?: unknown) => new NextRequest('http://localhost/api/leads/x/quarantine', { method, headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.2.0.${++n}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const ctx = (lead: string) => ({ params: Promise.resolve({ lead }) })
function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateFeedback(db); setScanDb(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' }); db.prepare("UPDATE scan_jobs SET status='running', attempts=1 WHERE id=?").run(job)
  const lead = hex(); db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,company_domain,event_date,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)").run(lead, job, 'Harbor Dental', 's', 'https://news.example/h', 'harbordental.example', '2026-10-01', 70, 70)
  setUser({ id: 'A', business_name: 'Acme' })
  return { db, lead }
}
const q = (db: Database.Database, id: string) => (db.prepare('SELECT quarantined_at FROM leads WHERE id = ?').get(id) as { quarantined_at: number | null }).quarantined_at
const fb = (db: Database.Database) => db.prepare("SELECT entity_kind, reason, reverted_at FROM lead_feedback").all() as { entity_kind: string; reason: string; reverted_at: number | null }[]

test('an invalid / non-string / missing-person reason is a 400 BEFORE any mutation: the lead is not quarantined and nothing is recorded', async () => {
  const { db, lead } = setup()
  for (const body of [{ feedback_reason: 'because' }, { feedback_reason: 5 }, { feedback_reason: null }, { feedback_reason: 'wrong_person' }, { feedback_reason: 'wrong_person', person: '  ' }]) {
    const r = await POST(req('POST', body), ctx(lead)); assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(q(db, lead), null, `not quarantined: ${JSON.stringify(body)}`); assert.equal(fb(db).length, 0)
  }
})
test('a valid reason quarantines AND learns (200, learned: true); releasing reverts exactly that (history kept); a bare quarantine teaches nothing', async () => {
  const { db, lead } = setup()
  const r = await POST(req('POST', { reason: 'wrong company', feedback_reason: 'wrong_industry' }), ctx(lead)); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { quarantined: true, learned: true })
  assert.notEqual(q(db, lead), null); assert.deepEqual(fb(db).map(x => [x.entity_kind, x.reason, x.reverted_at]), [['account', 'wrong_industry', null]])
  const d = await DELETE(req('DELETE'), ctx(lead)); assert.equal(d.status, 200); assert.deepEqual(await d.json(), { quarantined: false, reverted: 1 })
  assert.equal(q(db, lead), null); assert.equal(fb(db).length, 1); assert.notEqual(fb(db)[0].reverted_at, null)
  const b = await POST(req('POST', { reason: 'just no' }), ctx(lead)); assert.deepEqual(await b.json(), { quarantined: true, learned: false }); assert.equal(fb(db).length, 1, 'no new feedback')
})
test('another tenant gets 404 and neither quarantines nor learns', async () => {
  const { db, lead } = setup(); setUser({ id: 'B', business_name: 'Other' })
  const r = await POST(req('POST', { feedback_reason: 'competitor' }), ctx(lead)); assert.equal(r.status, 404); assert.equal(q(db, lead), null); assert.equal(fb(db).length, 0)
})
