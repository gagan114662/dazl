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
  const steps = rd('../app/app/home-steps.tsx')
  assert.match(steps, /state === null \|\| state\.hasKey \? REST/)
  assert.doesNotMatch(steps, /\[KEY_STEP, \.\.\.REST\]/)
  assert.match(rd('../app/app/seller-card.tsx'), /What you sell:/)
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
  assert.match(rd('../app/app/seller-card.tsx'), /setSaved\(String\(j\.sells/)
  const steps = rd('../app/app/home-steps.tsx')
  assert.doesNotMatch(steps, /free scans are used up/)
  assert.match(steps, /Could not check your AI key status/)
})

test('contact search note separates not-searched, searched-none and no-result; never claims a guess', async () => {
  const { contactSearchNote } = await import('../lib/outreach/published-email.ts')
  assert.match(contactSearchNote({ contact: null, confidence: null })!, /not run/)
  assert.match(contactSearchNote({ contact: null, confidence: 60, company_domain: 'pigment.com' })!, /read pigment\.com contact pages/)
  assert.match(contactSearchNote({ contact: null, confidence: 60, company_domain: null })!, /not proof/)
  assert.equal(contactSearchNote({ contact: 'a@b.com', confidence: 60 }), null)
  assert.equal(contactSearchNote({ contact: null, confidence: 60, enrichments: [{ connector: 'sitecrawl', kind: 'email', value: 'info@x.com', label: '', source_url: 'https://x.com/contact' }] }), null)
})
