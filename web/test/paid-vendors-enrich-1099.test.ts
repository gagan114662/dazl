// Refs #1099, Gagan's rule (15 Nov 03:38): dazl calls no paid third-party API in its default path except Claude. Every gate below runs with
// DAZL_PAID_VENDORS empty (the default an operator gets) and proves NO request reaches the vendor; a control names the vendor and proves
// the same code still runs when an operator opts in. Tests of the vendor code paths opt in (test/paid-vendors-on.ts),
// so each test here sets the variable itself. Invented companies and keys; fake fetch; no network.
// Part of the #1273 split: commenter import, the scan's notices and the price estimate.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { PAID_VENDOR_OFF } from '../lib/paid-vendors.ts'
import { enrichCommenters, migrateCommenterImport } from '../lib/scan/commenter-import.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential } from '../lib/connectors/store.ts'
import { estimateRun } from '../lib/scan/price-estimate.ts'

const OFF = { DAZL_PAID_VENDORS: '' }
const master = randomBytes(32)

test('commenter import: saved Apollo and PDL keys are not used unless named; the import says why', async () => {
  const seed = () => {
    const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateCommenterImport(db)
    const job = createJob(db, 'A', { business_name: 'B', industry: 'I', location: 'L' })
    db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('l1', ?, 'Jane Doe - VP Sales', 'Kestrel Dental', 'kestreldental.example', 'commented', 'https://www.linkedin.com/in/jane-doe')").run(job)
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
    db.prepare("INSERT INTO commenter_batches (id, user_id, job_id, context, total) VALUES ('b1', 'A', ?, 'commented on my post', 1)").run(job)
    saveCredential(db, 'A', 'enrich:apollo', 'test-apollo-key-1234', master); saveCredential(db, 'A', 'enrich:pdl', 'test-pdl-key-1234', master)
    return { db, job }
  }
  const calls: string[] = []
  const fetchImpl = (async (u: RequestInfo | URL) => { calls.push(String(u)); return new Response('{}', { status: 200 }) }) as typeof fetch
  const { db, job } = seed()
  await enrichCommenters(db, 'A', 'b1', { fetchImpl, master, env: OFF })
  assert.deepEqual(calls, [])
  assert.equal((db.prepare('SELECT count(*) AS n FROM connector_audit WHERE scan_job_id = ? AND status = ?').get(job, PAID_VENDOR_OFF) as { n: number }).n, 1)
  const c = seed()
  await enrichCommenters(c.db, 'A', 'b1', { fetchImpl, master, env: { DAZL_PAID_VENDORS: 'apollo' } })
  assert.ok((calls as string[]).some(u => u.includes('api.apollo.io')), 'control: named, Apollo is asked')
})
test('the price estimate lists no Apollo / PDL credits for saved keys the policy keeps off', () => {
  const ids = (env: Record<string, string>) => estimateRun({ budget: null, payer: 'you', enrichmentVendors: ['apollo', 'pdl'], env }).rows.map(r => r.id)
  assert.ok(!ids(OFF).some(id => id === 'apollo_credits' || id === 'pdl_credits'), JSON.stringify(ids(OFF)))
  assert.ok(ids({ DAZL_PAID_VENDORS: 'apollo,pdl' }).includes('apollo_credits'))
})
