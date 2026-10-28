import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob, cancelJob, countActiveJobs, getJob, reapStaleJobs } from '../lib/scan/store.ts'

function setup() { const db = new Database(':memory:'); migrateScan(db); return db }
const status = (db: Database.Database, id: string) => db.prepare('SELECT status,error,attempts,claimed_at FROM scan_jobs WHERE id=?').get(id) as { status: string; error: string | null; attempts: number; claimed_at: number | null }

test('cancel a pending job: terminal failed/cancelled, never claimable again', () => {
  const db = setup(); const id = createJob(db, 'A', { business_name: 'x', industry: 'i', location: 'l' })
  assert.deepEqual(cancelJob(db, 'A', id), { ok: true, was_running: false })
  assert.equal(status(db, id).status, 'failed'); assert.equal(status(db, id).error, 'cancelled')
  assert.equal(db.prepare("UPDATE scan_jobs SET status='running' WHERE id=? AND status='pending'").run(id).changes, 0)
})

test('cancel a running job fences late runner writes and the stale reaper', () => {
  const db = setup(); const id = createJob(db, 'A', { business_name: 'x', industry: 'i', location: 'l' })
  db.prepare("UPDATE scan_jobs SET status='running', attempts=1, claimed_at=1 WHERE id=?").run(id)
  assert.deepEqual(cancelJob(db, 'A', id), { ok: true, was_running: true })
  // the runner's late finish/lead insert for attempt 1 is rejected
  assert.equal(db.prepare("SELECT 1 FROM scan_jobs WHERE id=? AND status='running' AND attempts=1").get(id), undefined)
  assert.throws(() => db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url) VALUES('l1',?,'c','s','https://x.test/')").run(id), /running job/)
  reapStaleJobs(db)
  assert.equal(status(db, id).status, 'failed'); assert.equal(status(db, id).error, 'cancelled')
  assert.equal(getJob(db, 'A', id)?.attempts, 1)
})

test('tenant isolation, finished jobs, and double cancel', () => {
  const db = setup(); const id = createJob(db, 'A', { business_name: 'x', industry: 'i', location: 'l' })
  assert.deepEqual(cancelJob(db, 'B', id), { ok: false, reason: 'not_found' })
  assert.equal(status(db, id).status, 'pending')
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id); db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(id)
  assert.deepEqual(cancelJob(db, 'A', id), { ok: false, reason: 'already_finished' })
  const id2 = createJob(db, 'A', { business_name: 'y', industry: 'i', location: 'l' })
  assert.equal(cancelJob(db, 'A', id2).ok, true)
  assert.deepEqual(cancelJob(db, 'A', id2), { ok: false, reason: 'already_finished' })
})

test('a just-cancelled scan keeps its active slot for the hold window, then frees it', () => {
  const db = setup(); const id = createJob(db, 'A', { business_name: 'x', industry: 'i', location: 'l' })
  db.prepare("UPDATE scan_jobs SET status='running', attempts=1, claimed_at=1 WHERE id=?").run(id)
  assert.equal(countActiveJobs(db, 'A'), 1)
  cancelJob(db, 'A', id)
  assert.equal(countActiveJobs(db, 'A'), 1, 'still held right after cancel')
  db.prepare('UPDATE scan_jobs SET finished_at = finished_at - 400 WHERE id=?').run(id)
  assert.equal(countActiveJobs(db, 'A'), 0)
  assert.equal(countActiveJobs(db, 'B'), 0)
})

test('watch scheduler uses the shared active count (cancel hold + csv exclusion)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../lib/watch.ts', import.meta.url), 'utf8')
  assert.match(src, /countActiveJobs\(db, w\.user_id\)/)
  assert.doesNotMatch(src, /FROM scan_jobs WHERE user_id = \? AND \(status IN/)
})

test('leads page adopts a pending/running scan on load so a reload shows progress and disables Find leads', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(src, /x\.status === 'pending' \|\| x\.status === 'running'/)
  assert.match(src, /setJobId\(active\.id\)/)
})

test('status poll is passive only for explicit ?passive=1 (adoption resumes the queue)', async () => {
  const fs = await import('node:fs')
  const route = fs.readFileSync(new URL('../app/api/scan/status/route.ts', import.meta.url), 'utf8')
  assert.match(route, /passive'\) !== '1'\) after\(/)
  const ui = fs.readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(ui, /passive=1/)
  assert.match(ui, /passiveJob\.current = false; setJobId\(j\.job_id\)/)
  assert.doesNotMatch(ui, /passiveJob\.current = true/)
  assert.match(ui, /get\('passive'\) === '1'/)
})

test('Home never asks for an AI key once one is saved; seller profile stays visible; banner and sign-up copy are mode-accurate', async () => {
  const fs = await import('node:fs')
  const rd = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  // Home is the readiness checklist now: a saved key is done (no key fix offered) and the saved seller profile is shown.
  const { readinessRows } = await import('../lib/readiness.ts')
  const rows = readinessRows({ profile: { sells: 'Booking software', website: 'https://acme.example', business_name: 'Acme' }, usage: { has_key: true, trial: null }, outreach: { gmail: null, sender: null } })
  assert.deepEqual(rows.find(x => x.id === 'key'), { id: 'key', label: 'AI key', state: 'done', detail: 'saved', fix: null })
  assert.match(rows.find(x => x.id === 'site')!.detail, /Booking software/)
  assert.doesNotMatch(rd('../app/app/outreach/send-readiness.tsx'), /Every email still needs your approval/)
  assert.match(rd('../app/sign-up/page.tsx'), /with your own AI key/)
})

test('profile save returns canonical stored values; business name round-trips; keyless copy is neutral; usage failure is labelled', async () => {
  const { setSellerProfile, getSellerProfile, setBusinessName, getBusinessName } = await import('../lib/auth-db.ts')
  const db = new Database(':memory:')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, business_name TEXT, sells TEXT, website TEXT)')
  db.prepare("INSERT INTO users (id, business_name) VALUES ('u','')").run()
  setSellerProfile(db, 'u', 'x'.repeat(200), '')
  assert.equal(getSellerProfile(db, 'u').sells.length, 150)
  setBusinessName(db, 'u', '  Acme   Co  ')
  assert.equal(getBusinessName(db, 'u'), 'Acme Co')
  const fs = await import('node:fs')
  const rd = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  const route = rd('../app/api/settings/profile/route.ts')
  assert.match(route, /ok: true, \.\.\.getSellerProfile/)
  assert.match(route, /: cur\.sells/)
  assert.match(route, /: cur\.website/)
  // Home re-reads the stored profile after a save (never shows unsaved text); a usage failure reads "could not check".
  assert.match(rd('../app/app/readiness.tsx'), /setOpen\(null\); void load\(\)/)
  const { readinessRows } = await import('../lib/readiness.ts')
  const key = readinessRows({ profile: null, usage: null, outreach: null }).find(x => x.id === 'key')!
  assert.deepEqual([key.state, key.detail, key.fix], ['unknown', 'could not check - your plan and key status did not load', null])
})

test('contact search note states eligibility and stored facts only, never completion or absence', async () => {
  const { contactSearchNote } = await import('../lib/outreach/published-email.ts')
  assert.match(contactSearchNote({ contact: null, confidence: null })!, /not machine-verified/)
  const d = contactSearchNote({ contact: null, confidence: 60, company_domain: 'pigment.com' })!
  assert.match(d, /website identified: pigment\.com/)
  assert.match(d, /does not prove no address exists/)
  assert.doesNotMatch(d, /read .*pages|no role address/)
  assert.match(contactSearchNote({ contact: null, confidence: 60, company_domain: null })!, /website not confirmed/)
  assert.equal(contactSearchNote({ contact: 'a@b.com', confidence: 60 }), null)
  assert.equal(contactSearchNote({ contact: null, confidence: 60, enrichments: [{ connector: 'sitecrawl', kind: 'email', value: 'info@x.com', label: '', source_url: 'https://x.com/contact' }] }), null)
})

test('crawlJob records nothing when the deadline fires mid-crawl (no domain, no audit, no enrichment)', async () => {
  const { crawlJob } = await import('../lib/connectors/sitecrawl.ts')
  const { migrateConnectors } = await import('../lib/connectors/store.ts')
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec("CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)")
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Stabyl','https://stabyl.com/a',NULL,90,80,NULL)").run()
  const ctrl = new AbortController()
  const get = async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/contact') ctrl.abort() // deadline fires while the first contact page is requested
    if (path === '/robots.txt') return { status: 200, body: '', finalUrl: url }
    if (path === '/a') return { status: 200, body: '<a href="https://stabyl.com">s</a>', finalUrl: url }
    if (path === '/') return { status: 200, body: '<html>Stabyl home</html>', finalUrl: url }
    return { status: 200, body: '<html>hello@stabyl.com</html>', finalUrl: url }
  }
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, signal: ctrl.signal })
  assert.equal(ctrl.signal.aborted, true)
  assert.equal((db.prepare("SELECT company_domain AS d FROM leads WHERE id = 'l1'").get() as { d: string | null }).d, null)
  assert.equal((db.prepare('SELECT count(*) AS n FROM connector_audit').get() as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT count(*) AS n FROM lead_enrichments').get() as { n: number }).n, 0)
})

