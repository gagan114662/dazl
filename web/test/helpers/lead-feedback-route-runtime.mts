// The REAL quarantine and lead-feedback routes with a structured reason (#385): validated before any mutation, atomic,
// learned from, reset on release, explainable, tenant-isolated. In-memory store, synthetic leads, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createJob } from '../../lib/scan/store.ts'

process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-fb-')), 'app.db')
const { POST, DELETE } = await import('../../app/api/leads/[lead]/quarantine/route.ts')
const fbRoute = await import('../../app/api/leads/[lead]/feedback/route.ts')
const settings = await import('../../app/api/settings/feedback/route.ts')

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const hex = () => randomBytes(12).toString('hex')
let n = 0
const req = (method: string, body?: unknown) => new NextRequest('http://localhost/api/leads/x/quarantine', { method, headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.3.0.${++n}` }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
const ctx = (lead: string) => ({ params: Promise.resolve({ lead }) })
function setup() {
  const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' }); db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = hex(), named = hex()
  const ins = db.prepare('INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, company_domain, event_date, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 70, 70)')
  ins.run(lead, job, 'Harbor Dental', '', null, 's', 'https://news.example/h', 'harbordental.example', null)
  ins.run(named, job, 'Querix', 'Pat Doe', 'pat@querix.example', 's', 'https://news.example/q', null, '2026-10-01')
  setUser({ id: 'A', business_name: 'Acme' })
  return { db, lead, named }
}
const q = (db: Database.Database, id: string) => (db.prepare('SELECT quarantined_at FROM leads WHERE id = ?').get(id) as { quarantined_at: number | null }).quarantined_at
const fb = (db: Database.Database) => db.prepare('SELECT level, reason, verdict, reset_at, reset_reason FROM lead_feedback ORDER BY version').all() as { level: string; reason: string | null; verdict: string; reset_at: number | null; reset_reason: string | null }[]

test('a bad, non-string or unfit reason is a 400 BEFORE any mutation: not quarantined, nothing recorded', async () => {
  const { db, lead, named } = setup()
  for (const [id, body, code] of [[lead, { feedback_reason: 'bogus' }, 'invalid_feedback_reason'], [lead, { feedback_reason: 5 }, 'invalid_feedback_reason'], [lead, { feedback_reason: null }, 'invalid_feedback_reason'],
    [lead, { feedback_reason: 'wrong_person' }, 'person_required'], [lead, { feedback_reason: 'wrong_timing' }, 'event_date_required'], [named, { feedback_reason: 'wrong_person', person: 7 }, 'invalid_person']] as const) {
    const r = await POST(req('POST', body), ctx(id))
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal((await r.json()).error, code)
    assert.equal(q(db, id), null, `not quarantined: ${JSON.stringify(body)}`); assert.equal(fb(db).length, 0)
  }
})

test('a valid reason quarantines AND learns in one step; release resets it (history kept); a bare quarantine teaches nothing; accept is explicit', async () => {
  const { db, lead, named } = setup()
  const r = await POST(req('POST', { reason: 'Rejected: Wrong industry', feedback_reason: 'wrong_industry' }), ctx(lead))
  assert.equal(r.status, 200); const j = await r.json()
  assert.deepEqual([j.quarantined, j.feedback.level, j.feedback.reason, j.feedback.version], [true, 'account', 'wrong_industry', 1])
  assert.notEqual(q(db, lead), null)
  const p = await POST(req('POST', { feedback_reason: 'wrong_person' }), ctx(named))
  assert.equal(p.status, 200); assert.equal((await p.json()).feedback.level, 'person')
  const d = await DELETE(req('DELETE', {}), ctx(lead)); assert.equal(d.status, 200); assert.deepEqual(await d.json(), { quarantined: false, feedback_reset: 1 })
  assert.equal(q(db, lead), null)
  assert.deepEqual(fb(db).map(x => [x.level, x.reason, x.reset_reason]), [['account', 'wrong_industry', 'lead released'], ['person', 'wrong_person', null]])
  const bare = await POST(req('POST', { reason: 'just no' }), ctx(lead)); assert.deepEqual(await bare.json(), { quarantined: true, feedback: null }); assert.equal(fb(db).length, 2, 'hiding alone is not a reasoned label')
  // the feedback route: explicit accept, explain, reset by id with why
  assert.equal((await fbRoute.POST(req('POST', { verdict: 'reject' }), ctx(lead))).status, 400)
  const a = await fbRoute.POST(req('POST', { verdict: 'accept', note: 'good one' }), ctx(named)); assert.equal(a.status, 200)
  const accId = (await a.json()).feedback.id as string
  const ex = await (await fbRoute.GET(req('GET'), ctx(named))).json() as { feedback: { verdict: string; reason: string | null }[] }
  assert.deepEqual(ex.feedback.map(f => [f.verdict, f.reason]), [['accept', null], ['reject', 'wrong_person']])
  assert.equal((await fbRoute.DELETE(req('DELETE', { id: accId }), ctx(named))).status, 400, 'a reset says why')
  assert.equal((await fbRoute.DELETE(req('DELETE', { id: accId, reason: 'mis-click' }), ctx(named))).status, 200)
  assert.equal((await fbRoute.DELETE(req('DELETE', { id: accId, reason: 'again' }), ctx(named))).status, 404)
  // tenant-level: learned yield and a proposal; nothing applied until POSTed while current
  const s = await (await settings.GET()).json() as { source_yield: unknown[]; proposal: { add_exclusions: string[] } }
  assert.ok(Array.isArray(s.source_yield)); assert.deepEqual(s.proposal.add_exclusions, [])
})

test('another tenant gets 404 and neither quarantines, learns, explains nor resets', async () => {
  const { db, lead } = setup()
  const own = await POST(req('POST', { feedback_reason: 'competitor' }), ctx(lead)); const id = (await own.json()).feedback.id as string
  db.prepare('UPDATE leads SET quarantined_at = NULL WHERE id = ?').run(lead)
  setUser({ id: 'B', business_name: 'Other' })
  assert.equal((await POST(req('POST', { feedback_reason: 'competitor' }), ctx(lead))).status, 404)
  assert.equal((await DELETE(req('DELETE', {}), ctx(lead))).status, 404)
  assert.equal((await fbRoute.GET(req('GET'), ctx(lead))).status, 404)
  assert.equal((await fbRoute.POST(req('POST', { verdict: 'accept' }), ctx(lead))).status, 404)
  assert.equal((await fbRoute.DELETE(req('DELETE', { id, reason: 'x' }), ctx(lead))).status, 404)
  assert.equal(q(db, lead), null); assert.deepEqual(fb(db).map(x => [x.verdict, x.reset_at]), [['reject', null]])
  const s = await (await settings.GET()).json() as { source_yield: unknown[]; proposal: { add_exclusions: string[] } }
  assert.deepEqual([s.source_yield, s.proposal.add_exclusions], [[], []])
})
