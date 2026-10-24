import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { qualifyPreview } from '../lib/scan/qualify-preview.ts'

function setup() {
  const db = new Database(':memory:'); migrateScan(db)
  const mk = (user: string, id: string, domain: string | null) => {
    const job = createQueryJob(db, user, { query: 'B2B companies hiring sales roles' })
    db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
    db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,company_domain) VALUES (?,?,?,?,?,?)").run(id, job, 'Acme', 'Posted a role titled "SDR"', 'https://weworkremotely.com/remote-jobs/acme-sdr', domain)
  }
  mk('u1', 'a'.repeat(24), 'acme.example'); mk('u1', 'b'.repeat(24), null); mk('u2', 'c'.repeat(24), 'other.example')
  return db
}
const seen: string[] = []
const fetcher = async (url: string) => { seen.push(url); return url.includes('fail') ? { fail: 'blocked' as const } : { text: 'Acme runs outbound sales with five SDRs.', title: 't', retrievedAt: 1 } }

test('preview lists exactly the pages it would use and an estimate flagged as not a cap, with no model', async () => {
  const db = setup(); seen.length = 0
  const p = await qualifyPreview(db, 'u1', 'a'.repeat(24), 'Sales prospecting software for B2B sales teams', fetcher)
  assert.ok(p)
  assert.deepEqual(p.pages.map(x => [x.role, x.status]), [['posting', 'fetched'], ['company_home', 'fetched']])
  assert.deepEqual(seen, ['https://weworkremotely.com/remote-jobs/acme-sdr', 'https://acme.example/'])
  assert.equal(p.ready, false); assert.equal(p.cost?.is_guaranteed_cap, false); assert.equal(p.cost?.priced, false); assert.equal(p.scope?.pages_included.length, 2)
  const q = await qualifyPreview(db, 'u1', 'a'.repeat(24), 'x', fetcher, 'anthropic', 'claude-sonnet-4-5'); assert.equal(q?.cost?.priced, true); assert.equal(q?.ready, true); assert.match(q?.prompt_sha256 ?? '', /^[0-9a-f]{64}$/)
  const o = await qualifyPreview(db, 'u1', 'a'.repeat(24), 'x', fetcher, 'openai', 'gpt-4.1'); assert.equal(o?.ready, false); assert.ok(o?.notes.some(n => /No verified price for openai/.test(n)))
  const n = await qualifyPreview(db, 'u1', 'a'.repeat(24), 'x', fetcher, null, null); assert.ok(n?.notes.some(x => /No AI key/.test(x)))
})
test('no confirmed site means posting only, and it says so; no seller profile is not ready', async () => {
  const db = setup()
  const p = await qualifyPreview(db, 'u1', 'b'.repeat(24), '', fetcher)
  assert.ok(p); assert.equal(p.pages.length, 1); assert.equal(p.ready, false)
  assert.ok(p.notes.some(n => /No confirmed company site/.test(n))); assert.ok(p.notes.some(n => /No seller profile/.test(n)))
})
test('a posting page that does not name the company is fetched but not used as evidence', async () => {
  const db = setup()
  const p = await qualifyPreview(db, 'u1', 'a'.repeat(24), 'x', async (u: string) => ({ text: u.includes('weworkremotely') ? 'A page about something else entirely.' : 'Acme runs outbound.', title: 't', retrievedAt: 1 }), 'anthropic', 'claude-sonnet-4-5')
  assert.ok(p)
  assert.deepEqual(p.pages.map(x => [x.role, x.used]), [['posting', false], ['company_home', true]])
  assert.ok(p.notes.some(n => /does not name the company/.test(n)))
  assert.deepEqual(p.scope?.pages_included.map(x => x.role), ['company_home'])
})
test('another tenant gets nothing, and a failed fetch is reported not hidden', async () => {
  const db = setup()
  assert.equal(await qualifyPreview(db, 'u1', 'c'.repeat(24), 'x', fetcher), null)
  const p = await qualifyPreview(db, 'u2', 'c'.repeat(24), 'x', async () => ({ fail: 'blocked' as const }))
  assert.ok(p); assert.deepEqual(p.pages.map(x => x.status), ['failed', 'failed']); assert.equal(p.ready, false); assert.equal(p.cost, null)
})
