// Two tenants, the real route handlers for every route that takes a lead, batch or reply-thread id from the caller.
// Tenant B, signed in, uses tenant A's ids: every call must be refused or come back empty, must not return any of A's
// data, and must leave A's rows byte-unchanged. Positive controls show the same calls work for A on A's ids, so a
// handler that always refuses cannot pass. Any outbound fetch fails the test; nothing here is live data or a send.
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
import { addUserReportedPath } from '../../lib/warm/connections.ts'

// Routes that read the seller profile open the auth store: keep it in a throwaway file.
process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-ids-')), 'app.db')

const confirm = await import('../../app/api/leads/[lead]/confirm/route.ts')
const domainReview = await import('../../app/api/leads/[lead]/domain-review/route.ts')
const quarantine = await import('../../app/api/leads/[lead]/quarantine/route.ts')
const warm = await import('../../app/api/leads/[lead]/warm-path/route.ts')
const findContact = await import('../../app/api/leads/[lead]/find-contact/route.ts')
const evidence = await import('../../app/api/leads/evidence/route.ts')
const pageSignals = await import('../../app/api/leads/page-signals/route.ts')
const qualifyPreview = await import('../../app/api/leads/qualify-preview/route.ts')
const commenters = await import('../../app/api/scan/commenters/[batch]/route.ts')
const csv = await import('../../app/api/scan/csv/[batch]/route.ts')
const replies = await import('../../app/api/replies/[id]/route.ts')

const fetchCalls: string[] = []
globalThis.fetch = (async (u: unknown) => { fetchCalls.push(String(u)); throw new Error('Unexpected network call') }) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const hex = () => randomBytes(12).toString('hex')
const req = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost' }, body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = <T extends object>(p: T) => ({ params: Promise.resolve(p) })
// Every value below appears only in tenant A's rows; none may ever reach tenant B.
const MARK = ['ASECRETCO4q7', 'ASECRETMUTUAL4q7', 'ASECRETCONTEXT4q7', 'ASECRETDRAFT4q7', 'ASECRETTHREAD4q7', 'asecretdomain4q7']

function snapshot(db: Database.Database): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(t => t.name)
  return JSON.stringify(tables.map(t => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]))
}

function build() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  setScanDb(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'software', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = (extra: string) => {
    const id = hex()
    db.prepare(`INSERT INTO leads (id, scan_job_id, company, name, signal, source_url, score, confidence, company_domain ${extra ? ', ' + extra.split('=')[0] : ''})
      VALUES (?, ?, 'ASECRETCO4q7', 'Pat', 'Hiring', 'https://asecretdomain4q7.invalid/jobs', 70, 60, 'asecretdomain4q7.invalid' ${extra ? ', ' + extra.split('=')[1] : ''})`).run(id, job)
    return id
  }
  const review = lead("review_reason='needs a human check'")          // for confirm POST
  const confirmed = lead('human_confirmed_at=1700000000')               // for confirm DELETE / find-contact
  const quarantined = lead('quarantined_at=1700000000')                 // for quarantine DELETE
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'apollo', 'contact', 'ASECRETMUTUAL4q7 - VP', 'c', 90, 'https://www.linkedin.com/in/asecret4q7', '2026-10-01', 1)").run(hex(), review)
  const warmPath = addUserReportedPath(db, 'A', review, 'https://www.linkedin.com/in/asecret4q7', 'ASECRETMUTUAL4q7')!.id
  const commenterBatch = hex()
  db.prepare("INSERT INTO commenter_batches (id, user_id, context, total) VALUES (?, 'A', 'ASECRETCONTEXT4q7', 0)").run(commenterBatch)
  const csvBatch = hex()
  db.prepare("INSERT INTO csv_batches (id, user_id, total, note) VALUES (?, 'A', 1, 'ASECRETCONTEXT4q7')").run(csvBatch)
  db.prepare("INSERT INTO csv_rows (id, batch_id, domain) VALUES (?, ?, 'asecretdomain4q7.invalid')").run(hex(), csvBatch)
  const thread = hex()
  db.prepare("INSERT INTO reply_threads (id, tenant_id, platform, url, title, quote, query) VALUES (?, 'A', 'reddit', 'https://reddit.invalid/r/x', 'ASECRETTHREAD4q7', 'q', 'q')").run(thread)
  db.prepare("INSERT INTO reply_drafts (thread_id, tenant_id, draft) VALUES (?, 'A', 'ASECRETDRAFT4q7')").run(thread)
  return { db, review, confirmed, quarantined, warmPath, commenterBatch, csvBatch, thread }
}

test("tenant B cannot read or change tenant A's lead, batch or reply-thread rows by id; A's own calls work", async () => {
  const f = build()
  const { db } = f
  const before = snapshot(db)
  const done: string[] = []
  const failures: string[] = []
  const asB = async (name: string, call: () => Promise<Response | undefined>, ok: (status: number) => boolean) => {
    setUser(B)
    const res = await call()
    if (!res) { failures.push(`${name}: no response`); return }
    const text = await res.text()
    done.push(name)
    if (!ok(res.status)) failures.push(`${name}: B got ${res.status} ${text.slice(0, 120)}`)
    for (const m of MARK) if (text.includes(m)) failures.push(`${name}: response leaks A's ${m}`)
    if (snapshot(db) !== before) failures.push(`${name}: A's data changed`)
  }
  const is404 = (s: number) => s === 404
  const L = f.review
  await asB('POST /api/leads/[lead]/confirm', () => confirm.POST(req(`/api/leads/${L}/confirm`, 'POST', {}), ctx({ lead: L })), is404)
  await asB('POST /api/leads/[lead]/domain-review', () => domainReview.POST(req(`/api/leads/${L}/domain-review`, 'POST', { action: 'withdraw' }), ctx({ lead: L })), is404)
  await asB('POST /api/leads/[lead]/quarantine', () => quarantine.POST(req(`/api/leads/${L}/quarantine`, 'POST', { reason: 'x' }), ctx({ lead: L })), is404)
  await asB('DELETE /api/leads/[lead]/quarantine', () => quarantine.DELETE(req(`/api/leads/${f.quarantined}/quarantine`, 'DELETE'), ctx({ lead: f.quarantined })), is404)
  // GET answers for the caller's own (empty) warm paths: 200 with nothing of A's in it
  await asB('GET /api/leads/[lead]/warm-path', () => warm.GET(req(`/api/leads/${L}/warm-path`, 'GET'), ctx({ lead: L })), s => s === 200 || s === 404)
  await asB('POST /api/leads/[lead]/warm-path', () => warm.POST(req(`/api/leads/${L}/warm-path`, 'POST', { contact_url: 'https://www.linkedin.com/in/b-someone', mutual_name: 'B mutual' }), ctx({ lead: L })), s => s === 404 || s === 422) // 422 is also what a nonexistent lead gets: no existence oracle
  await asB('DELETE /api/leads/[lead]/warm-path', () => warm.DELETE(req(`/api/leads/${L}/warm-path`, 'DELETE', { id: f.warmPath }), ctx({ lead: L })), s => s === 404 || s === 200)
  await asB('POST /api/leads/[lead]/find-contact', () => findContact.POST(req(`/api/leads/${f.confirmed}/find-contact`, 'POST', {}), ctx({ lead: f.confirmed })), is404)
  await asB('GET /api/leads/evidence', () => evidence.GET(req(`/api/leads/evidence?lead_id=${L}`, 'GET')), is404)
  await asB('GET /api/leads/page-signals', () => pageSignals.GET(req(`/api/leads/page-signals?lead_id=${L}`, 'GET')), is404)
  await asB('GET /api/leads/qualify-preview', () => qualifyPreview.GET(req(`/api/leads/qualify-preview?lead_id=${L}`, 'GET')), is404)
  await asB('GET /api/scan/commenters/[batch]', () => commenters.GET(req(`/api/scan/commenters/${f.commenterBatch}`, 'GET'), ctx({ batch: f.commenterBatch })), is404)
  await asB('DELETE /api/scan/commenters/[batch]', () => commenters.DELETE(req(`/api/scan/commenters/${f.commenterBatch}`, 'DELETE'), ctx({ batch: f.commenterBatch })), is404)
  await asB('GET /api/scan/csv/[batch]', () => csv.GET(req(`/api/scan/csv/${f.csvBatch}`, 'GET'), ctx({ batch: f.csvBatch })), is404)
  await asB('POST /api/scan/csv/[batch]', () => csv.POST(req(`/api/scan/csv/${f.csvBatch}`, 'POST', {}), ctx({ batch: f.csvBatch })), is404)
  await asB('POST /api/replies/[id] save', () => replies.POST(req(`/api/replies/${f.thread}`, 'POST', { action: 'save', draft: 'B overwrite' }), ctx({ id: f.thread })), s => s === 400 || s === 404)
  await asB('POST /api/replies/[id] mark', () => replies.POST(req(`/api/replies/${f.thread}`, 'POST', { action: 'mark', status: 'posted' }), ctx({ id: f.thread })), is404)
  assert.deepEqual(failures, [])
  assert.equal(fetchCalls.length, 0, 'B never caused a network call')
  // B's own tables stay clean too: no row of B's points at A's lead
  assert.equal((db.prepare("SELECT count(*) AS n FROM warm_user_paths WHERE tenant_id = 'B'").get() as { n: number }).n, 0)

  // Positive controls: the same calls as A on A's ids really act.
  setUser(A)
  const st = async (p: Promise<Response>) => (await p).status
  assert.equal(await st(confirm.POST(req(`/api/leads/${L}/confirm`, 'POST', {}), ctx({ lead: L }))), 200)
  assert.equal(await st(quarantine.POST(req(`/api/leads/${L}/quarantine`, 'POST', { reason: 'x' }), ctx({ lead: L }))), 200)
  assert.equal(await st(quarantine.DELETE(req(`/api/leads/${f.quarantined}/quarantine`, 'DELETE'), ctx({ lead: f.quarantined }))), 200)
  const wg = await warm.GET(req(`/api/leads/${L}/warm-path`, 'GET'), ctx({ lead: L }))
  assert.match(await wg.text(), /ASECRETMUTUAL4q7/)
  assert.equal(await st(warm.POST(req(`/api/leads/${L}/warm-path`, 'POST', { contact_url: 'https://www.linkedin.com/in/a-other', mutual_name: 'A mutual' }), ctx({ lead: L }))), 200)
  const wd = await warm.DELETE(req(`/api/leads/${L}/warm-path`, 'DELETE', { id: f.warmPath }), ctx({ lead: L }))
  assert.deepEqual(await wd.json(), { deleted: true })
  const cg = await commenters.GET(req(`/api/scan/commenters/${f.commenterBatch}`, 'GET'), ctx({ batch: f.commenterBatch }))
  assert.match(await cg.text(), /ASECRETCONTEXT4q7/)
  const vg = (await csv.GET(req(`/api/scan/csv/${f.csvBatch}`, 'GET'), ctx({ batch: f.csvBatch })))!
  assert.equal(vg.status, 200)
  assert.equal(await st(replies.POST(req(`/api/replies/${f.thread}`, 'POST', { action: 'save', draft: 'A edit' }), ctx({ id: f.thread }))), 200)
  assert.equal(await st(replies.POST(req(`/api/replies/${f.thread}`, 'POST', { action: 'mark', status: 'posted' }), ctx({ id: f.thread }))), 200)
  assert.equal(await st(commenters.DELETE(req(`/api/scan/commenters/${f.commenterBatch}`, 'DELETE'), ctx({ batch: f.commenterBatch }))), 200)
  console.log('COHORT', done.length, JSON.stringify(done))
})
