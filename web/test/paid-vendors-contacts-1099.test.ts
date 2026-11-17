// Refs #1099, Gagan's rule (15 Nov 03:38): no paid third-party API in dazl's default path except Claude. DAZL_PAID_VENDORS empty = off; a control names the vendor.
// Split C of #1273: Apollo / PDL / ZeroBounce in commenter import, mailbox check and the price estimate. Fake fetch; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { PAID_VENDOR_OFF } from '../lib/paid-vendors.ts'
import { enrichCommenters, migrateCommenterImport } from '../lib/scan/commenter-import.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential } from '../lib/connectors/store.ts'
import { verifierFromEnv } from '../lib/people/email-pattern.ts'
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

test('mailbox check: a ZeroBounce key is not used unless named', () => {
  assert.equal(verifierFromEnv({ ZEROBOUNCE_API_KEY: 'zb-key', ...OFF }), null)
  assert.ok(verifierFromEnv({ ZEROBOUNCE_API_KEY: 'zb-key', DAZL_PAID_VENDORS: 'zerobounce' }))
})

test('the price estimate lists no Apollo / PDL credits for saved keys the policy keeps off', () => {
  const ids = (env: Record<string, string>) => estimateRun({ budget: null, payer: 'you', enrichmentVendors: ['apollo', 'pdl'], env }).rows.map(r => r.id)
  assert.ok(!ids(OFF).some(id => id === 'apollo_credits' || id === 'pdl_credits'), JSON.stringify(ids(OFF)))
  assert.ok(ids({ DAZL_PAID_VENDORS: 'apollo,pdl' }).includes('apollo_credits'))
})
